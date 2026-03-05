// src/services/supportService.js
// Topics-based support system.
//
// Flow:
//   User /support → bot creates a Forum Topic in SUPPORT_GROUP_ID
//   User messages → forwarded into that topic
//   Admin replies in topic → bot forwards reply back to user's DM
//   Admin closes topic (button) → user notified, topic archived
//   Overflow → SUPPORT_CONTACT

const SupportTicket = require('../models/SupportTicket');
const AdminLog = require('../models/AdminLog');
const logger = require('../utils/logger');

const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '@ImaxSupport1Bot';
const SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID;

const describeMessage = (message) => {
  if (!message) return 'No message content';

  const text = String(message.text || message.caption || '').trim();
  if (text) return text;

  if (Array.isArray(message.photo) && message.photo.length) return '[Photo]';
  if (message.video) return '[Video]';
  if (message.document) return '[Document]';
  if (message.audio) return '[Audio]';
  if (message.voice) return '[Voice message]';
  if (message.video_note) return '[Video note]';
  if (message.sticker) return '[Sticker]';
  if (message.animation) return '[GIF]';
  if (message.location) return '[Location]';
  if (message.contact) return '[Contact]';
  if (message.poll) return '[Poll]';

  return '[Unsupported message type]';
};

const copyMessageSafe = async (bot, toChatId, fromChatId, messageId, extra = {}) => {
  try {
    await bot.telegram.copyMessage(toChatId, fromChatId, messageId, {
      protect_content: true,
      ...extra,
    });
    return true;
  } catch (err) {
    logger.warn(`copyMessage failed (${fromChatId} -> ${toChatId}): ${err.message}`);
    return false;
  }
};

// Today as YYYY-MM-DD
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * Get the user's currently open ticket (if any)
 */
const getActiveTicket = async (telegramId) => {
  return SupportTicket.findOne({ telegramId, status: 'open' });
};

/**
 * Get ticket by forum topicId (used when admin replies in topic)
 */
const getTicketByTopicId = async (topicId) => {
  return SupportTicket.findOne({ topicId });
};

/**
 * Create a new forum topic + ticket record.
 */
const openTicket = async (bot, user, firstMessage, sourceMessage = null) => {
  // Create a forum topic named after the user
  const topicName = `${user.name} · ${user.telegramId}`;
  const topic = await bot.telegram.createForumTopic(SUPPORT_GROUP_ID, topicName, {
    icon_color: 0x6FB9F0, // light blue
  });

  // Post the opening message into the topic so admins see it immediately
  const userTag = user.username ? `@${user.username}` : `ID: ${user.telegramId}`;
  await bot.telegram.sendMessage(
    SUPPORT_GROUP_ID,
    `🎫 *New Support Ticket*\n\n` +
    `👤 *User:* ${user.name} (${userTag})\n` +
    `📅 *Opened:* ${new Date().toLocaleString('en-IN')}\n\n` +
    `📝 *First Message:*\n${firstMessage}\n\n` +
    `─────────────────\n` +
    `Reply in this thread → user gets your message.\n` +
    `Press *Close Ticket* below when done.`,
    {
      message_thread_id: topic.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Close Ticket', callback_data: `close_topic_${topic.message_thread_id}` },
        ]],
      },
    }
  );

  if (sourceMessage?.message_id && sourceMessage?.chat?.id) {
    await copyMessageSafe(
      bot,
      SUPPORT_GROUP_ID,
      sourceMessage.chat.id,
      sourceMessage.message_id,
      { message_thread_id: topic.message_thread_id }
    );
  }

  // Save ticket record
  const ticket = new SupportTicket({
    telegramId: user.telegramId,
    userId: user._id,
    userName: user.name,
    userUsername: user.username || null,
    topicId: topic.message_thread_id,
    firstMessage,
    openedDate: todayStr(),
  });
  await ticket.save();

  logger.info(`Support ticket ${ticket.ticketId} opened → topic ${topic.message_thread_id}`);
  return ticket;
};

/**
 * Forward a user's follow-up message into their open topic thread.
 */
const forwardUserMessage = async (bot, ticket, user, payload) => {
  const userTag = user.username ? `@${user.username}` : `User ${user.telegramId}`;

  if (payload?.message_id && payload?.chat?.id) {
    const copied = await copyMessageSafe(
      bot,
      SUPPORT_GROUP_ID,
      payload.chat.id,
      payload.message_id,
      { message_thread_id: ticket.topicId }
    );

    if (copied) return;
  }

  const fallbackText = typeof payload === 'string' ? payload : describeMessage(payload);
  await bot.telegram.sendMessage(
    SUPPORT_GROUP_ID,
    `💬 *${userTag}:*\n${fallbackText}`,
    {
      message_thread_id: ticket.topicId,
      parse_mode: 'Markdown',
    }
  );
};

/**
 * Forward an admin's topic reply back to the user's DM.
 * Called when bot detects a message in the support group thread.
 */
const forwardAdminReply = async (bot, ticket, adminName, payload) => {
  const { safeSend } = require('../utils/telegramUtils');

  const message = typeof payload === 'string' ? null : payload;

  if (message?.message_id && message?.chat?.id) {
    const copied = await copyMessageSafe(
      bot,
      ticket.telegramId,
      message.chat.id,
      message.message_id
    );

    if (copied) {
      await AdminLog.create({
        adminId: 0,
        actionType: 'support_reply',
        targetUserId: ticket.telegramId,
        details: { ticketId: ticket.ticketId, reply: describeMessage(message).substring(0, 100), adminName },
      });
      return;
    }
  }

  const fallbackText = typeof payload === 'string' ? payload : describeMessage(payload);
  await safeSend(
    bot,
    ticket.telegramId,
    `💬 *Support Team:*\n\n${fallbackText}`,
    { parse_mode: 'Markdown' }
  );

  await AdminLog.create({
    adminId: 0,
    actionType: 'support_reply',
    targetUserId: ticket.telegramId,
    details: { ticketId: ticket.ticketId, reply: fallbackText.substring(0, 100), adminName },
  });
};

/**
 * Close a ticket — archives the forum topic and notifies the user.
 */
const closeTicket = async (bot, topicId, closedBy = null, byUser = false) => {
  const ticket = await SupportTicket.findOneAndUpdate(
    { topicId, status: 'open' },
    {
      status: 'closed',
      closedAt: new Date(),
      closedBy,
      closedByUser: byUser,
    },
    { new: true }
  );

  if (!ticket) return null;

  // Archive (close) the forum topic
  try {
    await bot.telegram.closeForumTopic(SUPPORT_GROUP_ID, topicId);
  } catch (e) {
    logger.warn(`closeForumTopic failed: ${e.message}`);
  }

  // Notify user in DM
  const { safeSend } = require('../utils/telegramUtils');
  const closedByMsg = byUser
    ? 'You closed this support chat.'
    : 'Our support team has resolved your ticket.';

  await safeSend(
    bot,
    ticket.telegramId,
    `✅ *Support Chat Closed*\n\n` +
    `Ticket: \`${ticket.ticketId}\`\n` +
    `${closedByMsg}\n\n` +
    `If you need help again tomorrow, use /support.\n`,
    { parse_mode: 'Markdown' }
  );

  if (!byUser) {
    await AdminLog.create({
      adminId: closedBy || 0,
      actionType: 'close_ticket',
      targetUserId: ticket.telegramId,
      details: { ticketId: ticket.ticketId },
    });
  }

  logger.info(`Ticket ${ticket.ticketId} closed (byUser: ${byUser})`);
  return ticket;
};

/**
 * Get open tickets list for admin panel
 */
const getOpenTickets = async (limit = 15) => {
  return SupportTicket.find({ status: 'open' }).sort({ createdAt: -1 }).limit(limit);
};

module.exports = {
  openTicket,
  forwardUserMessage,
  forwardAdminReply,
  closeTicket,
  getActiveTicket,
  getTicketByTopicId,
  getOpenTickets,
  SUPPORT_CONTACT,
  SUPPORT_GROUP_ID,
};
