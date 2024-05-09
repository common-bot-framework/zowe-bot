/*
* This program and the accompanying materials are made available under the terms of the
* Eclipse Public License v2.0 which accompanies this distribution, and is available at
* https://www.eclipse.org/legal/epl-v20.html
*
* SPDX-License-Identifier: EPL-2.0
*
* Copyright Contributors to the Zowe Project.
*/

import { IChatContextData, ILogLevel, IMessage, IMessageType, ISlackOption, IChattingType, IUser, IChatToolType, IChannel,
    IPayloadType, IActionType, IEvent } from '../../types';
import type { SlackEventMiddlewareArgs, SlackViewMiddlewareArgs, AllMiddlewareArgs, SlackActionMiddlewareArgs, AppOptions } from '@slack/bolt';
import { ExpressReceiverOptions } from '@slack/bolt';
import { WebClient } from '@slack/web-api';

import { CommonBot } from '../../CommonBot';
import { Middleware } from '../../Middleware';
import { Logger } from '../../utils/Logger';
import { App, LogLevel } from '@slack/bolt';
import { Util } from '../../utils/Util';
import { SlackListener } from './SlackListener';
import { SlackRouter } from './SlackRouter';
import { Receiver } from './Receiver';

const logger = Logger.getInstance();

export class SlackMiddleware extends Middleware {
    private app: App;
    private botName: string = '';
    private users: Map<string, IUser>;
    private channels: Map<string, IChannel>;

    // Constructor
    constructor(bot: CommonBot) {
        super(bot);

        this.users = new Map<string, IUser>();
        this.channels = new Map<string, IChannel>();
        const option = this.bot.getOption();
        if (option.chatTool.type !== IChatToolType.SLACK) {
            logger.error(`Wrong chat tool type set in bot option: ${option.chatTool.type}`);
            throw new Error(`Wrong chat tool type`);
        }

        // Mapping ILogLevel to @slack/bolt LogLevel
        const logOption = logger.getOption();
        let logLevel: LogLevel;
        if (logOption.level == ILogLevel.DEBUG || logOption.level == ILogLevel.SILLY || logOption.level == ILogLevel.VERBOSE) {
            logLevel = LogLevel.DEBUG;
        } else if (logOption.level == ILogLevel.ERROR) {
            logLevel = LogLevel.ERROR;
        } else if (logOption.level == ILogLevel.INFO) {
            logLevel = LogLevel.INFO;
        } else if (logOption.level == ILogLevel.WARN) {
            logLevel = LogLevel.WARN;
        } else {
            // Should not happen, just for robustness.
            logger.error('Wrong log level');
        }

        // Create the slack receiver if socket mode is not enabled
        const slackOption: ISlackOption = <ISlackOption>option.chatTool.option;
        if (slackOption.socketMode === false) {
            logger.debug(`Socket mode is not enabled, start the http/https receiver`);
            const expressReceiverOptions: ExpressReceiverOptions = {
                'signingSecret': slackOption.signingSecret,
                'endpoints': slackOption.endpoints,
                'logLevel': logLevel,
            };
            logger.debug(`expressReceiverOptions: ${JSON.stringify(expressReceiverOptions)}`);
            const receiver = new Receiver(expressReceiverOptions);
            // Replace the default application with the provided one.
            if (option.messagingApp.app !== null) {
                receiver.setApp(option.messagingApp.app);
            }
            (<ISlackOption>option.chatTool.option).receiver = receiver;
        } else {
            // While socket mode is enabled, receiver should be undefined.
            slackOption.receiver = undefined;
        }

        // Create the bolt app: https://slack.dev/bolt-js/reference#initialization-options
        this.app = new App(<AppOptions>option.chatTool.option);

        this.run = this.run.bind(this);
        this.send = this.send.bind(this);
        this.processMessage = this.processMessage.bind(this);
        this.processAction = this.processAction.bind(this);
        this.processViewAction = this.processViewAction.bind(this);
    }

    // Run middleware
    async run(): Promise<void> {
        // Print start log
        logger.start(this.run, this);

        // Initializes your app with your bot token and signing secret
        try {
            const option = this.bot.getOption();
            // Only start the receiver if the app use socket mode
            if ((<ISlackOption>option.chatTool.option).socketMode === true) {
                await this.app.start();
            }

            this.app.message(/.*/, this.processMessage);
            this.app.action(/.*/, this.processAction);
            this.app.view(/.*/, this.processViewAction);
        } catch (err) {
            // Print exception stack
            logger.error(logger.getErrorStack(new Error(err.name), err));
        } finally {
            // Print end log
            logger.end(this.run, this);
        }
    }

    // Process normal message
    async processMessage(slackEvent: SlackEventMiddlewareArgs<'message'> & AllMiddlewareArgs): Promise<void> {
        // Print start log
        logger.start(this.processMessage, this);

        try {
            logger.debug(`slackEvent: ${JSON.stringify(slackEvent)}`);

            const chatToolContext = {
                'message': slackEvent.message,
                'context': slackEvent.context,
                'client': slackEvent.client,
                'body': slackEvent.body,
                'payload': slackEvent.payload,
            };

            // Cache the bot Name
            // The bot user real_name is the display name that user configured on the slack app configuration page.
            // This is also the name that you are referring when you @ the bot
            if (this.botName === undefined || this.botName.trim() === '') {
                const botUserInfo = await slackEvent.client.users.info({ user: slackEvent.context.botUserId });
                logger.debug(`Bot user info: ${JSON.stringify(botUserInfo)}`);
                this.botName = botUserInfo.user.real_name;
            }

            // Search the user from cached users.
            // (<Record<string, any>>slackEvent.message).user is the id of the user
            let user = this.getUser((<Record<string, any>>slackEvent.message).user); // eslint-disable-line @typescript-eslint/no-explicit-any
            // if user have not been cached, then search from the slack server and cache it
            if (user === undefined ) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const userInfo = await slackEvent.client.users.info({ user: (<Record<string, any>>slackEvent.message).user });
                logger.debug(`Cache the user info: ${JSON.stringify(userInfo)}`);
                user = { id: userInfo.user.id, name: userInfo.user.real_name, email: userInfo.user.profile.email };
                this.addUser(userInfo.user.id, user);
            }

            // Search the channel from cached channels.
            const channelId = slackEvent.message.channel;
            let channel: IChannel = this.channels.get(channelId);
            // if channel have not been cached, then search from the slack server and cache it.
            if (channel == undefined ) {
                channel = await this.getChannelById(channelId, slackEvent.client as any);
                this.channels.set(channelId, channel);
            }

            let message = '';

            // message Example
            // message: {"client_msg_id":"0716d94a-1561-4154-b0ce-12386a3b9b6f","type":"message","text":"<@U034W9HMH9V> _*help ad*_   ~_cdfad_~    `<https://www.ibm.com>`     <https://www.ibm.com>","user":"W0197PJSJAG","ts":"1646978508.524889","team":"T0197NLG020","blocks":[{"type":"rich_text","block_id":"W4yRm","elements":[{"type":"rich_text_section","elements":[{"type":"user","user_id":"U034W9HMH9V"},{"type":"text","text":" "},{"type":"text","text":"help ad","style":{"bold":true,"italic":true}},{"type":"text","text":"   "},{"type":"text","text":"cdfad","style":{"italic":true,"strike":true}},{"type":"text","text":"    "},{"type":"link","url":"https://www.ibm.com","style":{"code":true}},{"type":"text","text":"     "},{"type":"link","url":"https://www.ibm.com"}]}]}],"channel":"G01F96Y55KJ","event_ts":"1646978508.524889","channel_type":"group"}
            // Get the message text
            const reg = new RegExp(`<@${slackEvent.context.botUserId}>`, 'g');
            message = (<Record<string, any>>slackEvent.message).text.replace(reg, `@${this.botName}`); // eslint-disable-line @typescript-eslint/no-explicit-any

            // Try to get the raw message
            let rawMessage = '';
            if ((<Record<string, any>>slackEvent.message).blocks !== undefined) { // eslint-disable-line @typescript-eslint/no-explicit-any
                const messageBlocks = (<Record<string, any>>slackEvent.message).blocks; // eslint-disable-line @typescript-eslint/no-explicit-any
                for (const block of messageBlocks) {
                    // Get the rich_text block
                    if (block.type === 'rich_text' && block.elements !== undefined) {
                        for (const element of block.elements) {
                            if (element.type === 'rich_text_section' && element.elements !== undefined) {
                                logger.debug(`Find block rich_text_section to get the raw message`);
                                for (const richTextElement of element.elements) {
                                    // Only consider user, link && text element.
                                    if (richTextElement.type == 'user' && richTextElement.user_id == slackEvent.context.botUserId) {
                                        rawMessage = `${rawMessage}@${this.botName}`;
                                    } else if (richTextElement.type === 'text') {
                                        rawMessage = rawMessage + richTextElement.text;
                                    } else if (richTextElement.type === 'link') {
                                        rawMessage = rawMessage + richTextElement.url;
                                    }
                                }
                                // Only parsing one rich_text_section.
                                break;
                            }
                        }
                    }

                    // Only parsing one rich_text if it's not empty.
                    if (rawMessage != '') {
                        break;
                    }
                }
            }

            logger.debug(`rawMessage: ${rawMessage}`);
            // If rawMessage is not empty, using rawMessage
            if (rawMessage !== '') {
                message = rawMessage;
            }

            // Add @<bot name> if the direct message doesn't contain it.
            if (channel.chattingType == IChattingType.PERSONAL) {
                if (message.indexOf(`@${this.botName}`) === -1) {
                    message = `@${this.botName} ${message}`;
                }
            }

            const chatContextData: IChatContextData = {
                'payload': {
                    'type': IPayloadType.MESSAGE,
                    'data': message,
                },
                'context': {
                    'chatting': {
                        'bot': this.bot,
                        'type': channel.chattingType,
                        'user': {
                            'id': user.id,
                            'name': user.name,
                            'email': user.email,
                        },
                        'channel': {
                            'id': channel.id,
                            'name': channel.name,
                        },
                        'team': {
                            'id': '',
                            'name': '',
                        },
                        'tenant': {
                            'id': '',
                            'name': '',
                        },
                    },
                    'chatTool': chatToolContext,
                },
            };
            logger.debug(`Chat context data sent to chat bot: ${Util.dumpObject(chatContextData, 2)}`);

            // Get listeners
            const listeners = <SlackListener[]> this.bot.getListeners();

            // Match and process message
            for (const listener of listeners) {
                const matchers = listener.getMessageMatcher().getMatchers();
                for (const matcher of matchers) {
                    const matched: boolean = matcher.matcher(chatContextData);
                    if (matched) {
                    // Call message handler to process message
                        for (const handler of matcher.handlers) {
                            await handler(chatContextData);
                        }
                    }
                }
            }
        } catch (err) {
            // Print exception stack
            logger.error(logger.getErrorStack(new Error(err.name), err));
        } finally {
            // Print end log
            logger.end(this.processMessage, this);
        }
    }

    // Process user interactive actions e.g. button clicks, menu selects.
    async processAction(slackEvent: SlackActionMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
        // Print start log
        logger.start(this.processAction, this);

        try {
            logger.debug(`slackEvent: ${JSON.stringify(slackEvent)}`);

            // Acknowledge slack server at once for the 3s requirement.
            await slackEvent.ack();

            const chatToolContext = {
                'context': slackEvent.context,
                'client': slackEvent.client,
                'body': slackEvent.body,
                'payload': slackEvent.payload,
            };

            // Cache the bot Name
            // The bot user real_name is the display name that user configured on the slack app configuration page.
            // This is also the name that you are referring when you @ the bot
            if (this.botName === undefined || this.botName.trim() === '') {
                const botUserInfo = await slackEvent.client.users.info({ user: slackEvent.context.botUserId });
                logger.debug(`Bot user info: ${JSON.stringify(botUserInfo)}`);
                this.botName = botUserInfo.user.real_name;
            }

            // Search the user from cached users.
            // (<Record<string, any>>slackEvent.message).user is the id of the user
            let user = this.getUser((<Record<string, any>>slackEvent.body).user.id); // eslint-disable-line @typescript-eslint/no-explicit-any
            // if user have not been cached, then search from the slack server and cache it
            if (user === undefined ) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const userInfo = await slackEvent.client.users.info({ user: (<Record<string, any>>slackEvent.body).user.id });
                logger.debug(`Cache the user info: ${JSON.stringify(userInfo)}`);
                user = { id: userInfo.user.id, name: userInfo.user.real_name, email: userInfo.user.profile.email };
                this.addUser(userInfo.user.id, user);
            }

            // Search the channel from cached channels.
            const channelId = slackEvent.body.channel.id;
            let channel: IChannel = this.channels.get(channelId);
            // if channel have not been cached, then search from the slack server and cache it.
            if (channel == undefined ) {
                channel = await this.getChannelById(channelId, slackEvent.client as any);
                this.channels.set(channelId, channel);
            }

            // Get  event
            const event: IEvent = {
                'pluginId': '',
                'action': {
                    'id': '',
                    'type': null,
                    'token': '',
                },
            };
            const eventBody: any = slackEvent.body; // eslint-disable-line @typescript-eslint/no-explicit-any
            const actionId = eventBody.actions[0].action_id;
            const segments = actionId.split(':');
            if (segments.length >= 3) {
                event.pluginId = segments[0];
                event.action.id = segments[1];
                event.action.token = segments[2];
            } else {
                logger.error(`The data format of action_id is wrong!\n action_id=${actionId}`);
            }
            if (eventBody.type === 'view_submission') {
                event.action.type = IActionType.DIALOG_SUBMIT;
            } else {
                if (eventBody.actions[0].type === 'static_select') {
                    event.action.type = IActionType.DROPDOWN_SELECT;
                } else if (eventBody.actions[0].type === 'button') {
                    if (event.action.id.startsWith('DIALOG_OPEN_')) {
                        event.action.type = IActionType.DIALOG_OPEN;
                    } else {
                        event.action.type = IActionType.BUTTON_CLICK;
                    }
                } else {
                    event.action.type = IActionType.UNSUPPORTED;
                    logger.error(`Unsupported Slack interactive component: ${eventBody.actions[0].type}`);
                }
            }

            const chatContextData: IChatContextData = {
                'payload': {
                    'type': IPayloadType.EVENT,
                    'data': event,
                },
                'context': {
                    'chatting': {
                        'bot': this.bot,
                        'type': channel.chattingType,
                        'user': {
                            'id': user.id,
                            'name': user.name,
                            'email': user.email,
                        },
                        'channel': {
                            'id': channel.id,
                            'name': channel.name,
                        },
                        'team': {
                            'id': '',
                            'name': '',
                        },
                        'tenant': {
                            'id': '',
                            'name': '',
                        },
                    },
                    'chatTool': chatToolContext,
                },
            };

            // Get router
            const router = <SlackRouter> this.bot.geRouter();

            // Call route handler for mouse navigation
            await router.getRoute().handler(chatContextData);
        } catch (err) {
            // Print exception stack
            logger.error(logger.getErrorStack(new Error(err.name), err));
        } finally {
            // Print end log
            logger.end(this.processAction, this);
        }
    }

    async processViewAction(slackEvent: SlackViewMiddlewareArgs & AllMiddlewareArgs): Promise<void> {
        // Print start log
        logger.start(this.processViewAction, this);

        try {
            logger.debug(`slackEvent: ${JSON.stringify(slackEvent)}`);

            // Acknowledge slack server at once for the 3s requirement.
            await slackEvent.ack();

            const chatToolContext = {
                'context': slackEvent.context,
                'client': slackEvent.client,
                'body': slackEvent.body,
                'payload': slackEvent.payload,
            };

            // Cache the bot Name
            // The bot user real_name is the display name that user configured on the slack app configuration page.
            // This is also the name that you are referring when you @ the bot
            if (this.botName === undefined || this.botName.trim() === '') {
                const botUserInfo = await slackEvent.client.users.info({ user: slackEvent.context.botUserId });
                logger.debug(`Bot user info: ${JSON.stringify(botUserInfo)}`);
                this.botName = botUserInfo.user.real_name;
            }

            // Search the user from cached users.
            // (<Record<string, any>>slackEvent.message).user is the id of the user
            let user = this.getUser((<Record<string, any>>slackEvent.body).user.id); // eslint-disable-line @typescript-eslint/no-explicit-any
            // if user have not been cached, then search from the slack server and cache it
            if (user === undefined ) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const userInfo = await slackEvent.client.users.info({ user: (<Record<string, any>>slackEvent.body).user.id });
                logger.debug(`Cache the user info: ${JSON.stringify(userInfo)}`);
                user = { id: userInfo.user.id, name: userInfo.user.real_name, email: userInfo.user.profile.email };
                this.addUser(userInfo.user.id, user);
            }

            const privateMetaData = JSON.parse(slackEvent.payload.private_metadata);

            // Search the channel from cached channels.
            const channelId = privateMetaData.channelId;
            let channel: IChannel = this.channels.get(channelId);
            // if channel have not been cached, then search from the slack server and cache it.
            if (channel == undefined ) {
                channel = await this.getChannelById(channelId, slackEvent.client as any);
                this.channels.set(channelId, channel);
            }

            // Get  event
            const event: IEvent = {
                'pluginId': privateMetaData.pluginId,
                'action': {
                    'id': privateMetaData.action.id,
                    'type': IActionType.DIALOG_SUBMIT,
                    'token': privateMetaData.action.token,
                },
            };

            const chatContextData: IChatContextData = {
                'payload': {
                    'type': IPayloadType.EVENT,
                    'data': event,
                },
                'context': {
                    'chatting': {
                        'bot': this.bot,
                        'type': channel.chattingType,
                        'user': {
                            'id': user.id,
                            'name': user.name,
                            'email': user.email,
                        },
                        // View Action doesn't contain the context channel information. Using privateMetaData
                        'channel': {
                            'id': channel.id,
                            'name': channel.name,
                        },
                        'team': {
                            'id': '',
                            'name': '',
                        },
                        'tenant': {
                            'id': '',
                            'name': '',
                        },
                    },
                    'chatTool': chatToolContext,
                },
            };

            // Get router
            const router = <SlackRouter> this.bot.geRouter();

            // Call route handler for mouse navigation
            await router.getRoute().handler(chatContextData);
        } catch (err) {
        // Print exception stack
            logger.error(logger.getErrorStack(new Error(err.name), err));
        } finally {
        // Print end log
            logger.end(this.processViewAction, this);
        }
    }

    // Send message back to Slack channel
    async send(chatContextData: IChatContextData, messages: IMessage[]): Promise<void> {
        // Print start log
        logger.start(this.send, this);

        try {
            for (const msg of messages) {
                logger.debug(`msg: ${JSON.stringify(msg, null, 2)}`);
                if (msg.type == IMessageType.SLACK_VIEW_OPEN) {
                    await this.app.client.views.open(msg.message);
                } else if (msg.type == IMessageType.SLACK_VIEW_UPDATE) {
                    await this.app.client.views.update(msg.message);
                } else if (msg.type == IMessageType.PLAIN_TEXT) {
                    await this.app.client.chat.postMessage({
                        'channel': chatContextData.context.chatting.channel.id,
                        'text': msg.message,
                    });
                } else {
                    if (msg.message.text === undefined || msg.message.text === null) {
                        msg.message.text = 'New message from Common bot';
                    }
                    await this.app.client.chat.postMessage(msg.message);
                }
            }
        } catch (err) {
            // Print exception stack
            logger.error(logger.getErrorStack(new Error(err.name), err));
        } finally {
            // Print end log
            logger.end(this.send, this);
        }
    }

    // Get user infos
    getUser(id: string): IUser {
        return this.users.get(id);
    }

    // Add the user
    addUser(id: string, user: IUser): boolean {
        let result: boolean = true;
        if (id === undefined || id.trim() === '') {
            result = false;
            return result;
        }

        this.users.set(id, user);
        result = true;
        return result;
    }

    // get channel by id
    async getChannelById(id: string, slackWebClient: WebClient): Promise<IChannel> {
        logger.start(this.getChannelById);

        try {
            const conversationInfo = await slackWebClient.conversations.info({ channel: id });

            let chattingType: IChattingType = IChattingType.UNKNOWN;
            if (conversationInfo.channel.is_channel == true && conversationInfo.channel.is_mpim == false) {
                chattingType = IChattingType.PUBLIC_CHANNEL;
            } else if (conversationInfo.channel.is_group == true) {
                chattingType = IChattingType.PRIVATE_CHANNEL;
            } else if (conversationInfo.channel.is_im == true) {
                chattingType = IChattingType.PERSONAL;
            } else if (conversationInfo.channel.is_mpim == true) {
                chattingType = IChattingType.GROUP;
            }

            const channel: IChannel = {
                'id': id,
                'name': conversationInfo.channel.name,
                'chattingType': chattingType,
            };

            return channel;
        } catch (err) {
            logger.error(logger.getErrorStack(new Error(err.name), err));
        } finally {
            logger.end(this.getChannelById, this);
        }
    }
}
