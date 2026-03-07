// src/index.js
// Main entry point — wires up DB, bot, cron jobs, and optional health check

require('dotenv').config({ override: true });
const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

const connectDB = require('./config/database');
const logger = require('./utils/logger');
const { registerUserHandlers } = require('./bot/handlers');
const { registerAdminHandlers } = require('./bot/adminHandlers');
const { registerSuperAdminHandlers } = require('./bot/superAdminHandlers');
const { initCronJobs } = require('./services/cronService');
const { revokeInviteLink } = require('./utils/telegramUtils');

const parseSuperAdminIds = () => {
  return String(process.env.SUPER_ADMIN_IDS || process.env.SUPER_ADMIN_ID || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);
};

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// Validate required env vars
const required = ['BOT_TOKEN', 'MONGO_URI', 'LOG_CHANNEL_ID'];
for (const key of required) {
  if (!process.env[key]) {
    logger.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const configuredPremiumGroups = [
  process.env.MOVIE_PREMIUM_GROUP_ID,
  process.env.DESI_PREMIUM_GROUP_ID,
  process.env.NON_DESI_PREMIUM_GROUP_ID,
  process.env.PREMIUM_GROUP_ID,
].filter(Boolean);

if (!configuredPremiumGroups.length) {
  logger.error('Missing premium group configuration. Set at least one of MOVIE_PREMIUM_GROUP_ID, DESI_PREMIUM_GROUP_ID, NON_DESI_PREMIUM_GROUP_ID, or PREMIUM_GROUP_ID.');
  process.exit(1);
}

const superAdminIds = parseSuperAdminIds();
if (!superAdminIds.length) {
  logger.error('Missing SUPER_ADMIN_IDS or SUPER_ADMIN_ID. Configure at least one super admin Telegram ID.');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const protectBotMessages = String(process.env.PROTECT_BOT_MESSAGES || 'true').toLowerCase() !== 'false';
if (protectBotMessages) {
  const protectedMethods = new Set([
    'sendMessage',
    'sendPhoto',
    'sendVideo',
    'sendAudio',
    'sendDocument',
    'sendVoice',
    'sendAnimation',
    'sendVideoNote',
    'sendSticker',
    'sendMediaGroup',
  ]);

  const originalCallApi = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = (method, payload, ...rest) => {
    const safePayload = payload && typeof payload === 'object' ? { ...payload } : payload;

    if (
      safePayload &&
      protectedMethods.has(method) &&
      typeof safePayload.protect_content === 'undefined'
    ) {
      safePayload.protect_content = true;
    }

    return originalCallApi(method, safePayload, ...rest);
  };

  logger.info('Bot content protection enabled (anti-forward on supported clients).');
}

// Global error handler — prevents crashes on unexpected Telegram errors
bot.catch((err, ctx) => {
  const message = err?.response?.description || err?.description || err?.message || '';
  if (String(message).toLowerCase().includes('message is not modified')) {
    return;
  }

  logger.error(`Bot error [${ctx.updateType}]: ${err.message}`);
  if (ctx.reply) {
    ctx.reply('❌ An unexpected error occurred. Please try again.').catch(() => { });
  }
});

// Revoke invite link immediately after first successful join (single-use hardening)
bot.on('chat_member', async (ctx, next) => {
  try {
    const update = ctx.update?.chat_member;
    const oldStatus = update?.old_chat_member?.status;
    const newStatus = update?.new_chat_member?.status;
    const invite = update?.invite_link;
    const joinedNow = ['member', 'administrator', 'creator'].includes(newStatus)
      && ['left', 'kicked'].includes(oldStatus);

    if (joinedNow && invite?.invite_link) {
      const linkName = String(invite.name || '');
      if (linkName.startsWith('User_')) {
        await revokeInviteLink(bot, update.chat.id, invite.invite_link);
      }
    }
  } catch (err) {
    logger.warn(`chat_member invite revoke handler error: ${err.message}`);
  }

  return next();
});

// Global guard: blocked users cannot use the bot
bot.use(async (ctx, next) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return next();

  const User = require('./models/User');
  const user = await User.findOne({ telegramId });
  if (!user?.isBlocked) return next();

  const supportContact = process.env.SUPPORT_CONTACT || '@ImaxSupport1Bot';
  const blockedMsg = `⛔ *You have been banned from using this bot.*\n\nPlease contact support for this issue: ${supportContact}`;

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('You are banned. Contact support.', { show_alert: true }).catch(() => { });
  }

  if (ctx.reply) {
    await ctx.reply(blockedMsg, { parse_mode: 'Markdown' }).catch(() => { });
  }
});

// Register all handler layers
registerUserHandlers(bot);
registerAdminHandlers(bot);
registerSuperAdminHandlers(bot);

// ── /help ──────────────────────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  const User = require('./models/User');
  const user = await User.findOne({ telegramId: ctx.from.id });
  const role = user?.role || 'user';

  let msg = `🤖 *Bot Commands*\n\n`;
  msg += `*User:*\n/start — Main menu\n/menu — Quick main menu\n/status — Subscription status\n/offers — View current offers\n/referral — Your referral link\n/seller — Seller program dashboard\n/sellerwithdraw — Request seller withdrawal\n/sellerpayouts — Seller payout status\n/support — Open a support ticket\n/cancel — Close active support chat\n/help — This message\n`;

  if (['admin', 'superadmin'].includes(role)) {
    msg += `\n*Admin:*\n/user <id> — User search panel\n/ban <id> — Ban user from bot\n/unban <id> — Restore bot access\n/invite <id> — Send fresh join link / reset pending request\n/offeruser <id>|<discount> — One-time private offer (today only)\n/revokeplan <id> — Terminate subscription + remove from group\n/modifyplan <id>|<planIdOrDays> — Correct user plan\n/legacyadd <planIdOrDays>|<DD/MM/YYYY>|<id1,id2,...> — Import old active members\n/expiries [today|0|1|3|7] — Check upcoming expiry users\n/plans — Active plans\n/tickets — Open support tickets\n/filter "Any Word" — Reply to text/photo/sticker to set DM auto-response\n/unfilter "Any Word" — Remove DM trigger filter\n/filters — List all DM trigger filters\n`;
  }
  if (role === 'superadmin') {
    msg += `\n*Super Admin:*\n/addadmin <id> /removeadmin <id> /admins\n` +
      `/createplan /editplan /deleteplan /pauseplan /resumeplan /listplans\n` +
      `/addoffer /deleteoffer /listoffers\n` +
      `/removeprivateoffers all|<id> — Delete private user offers\n` +
      `/broadcast — Broadcast to users\n` +
      `/bcancel — Cancel active broadcast compose session\n` +
      `/report <Nd|Nm> — Custom CSV report (e.g. 7d, 28d, 1m)\n` +
      `/sellerpayoutscsv [Nd|Nm|all] — Seller payout CSV export\n` +
      `/sellerwithdrawalscsv [Nd|Nm|all] [status] — Withdrawals-only CSV export\n` +
      `/sellerstats [limit] — Seller list (ID, referrals, balance)\n` +
      `/referralstats [limit] — User referral leaderboard\n` +
      `/health — Runtime snapshot (DB/bot/cron)\n` +
      `/reports — Sales reports\n` +
      `/stats — Growth dashboard\n` +
      `/categorystats — Category-wise CSV snapshot\n` +
      `/planstats — Plan performance\n` +
      `/adminlogs — Audit log\n` +
      `/sellerwithdrawals /approvesellerwd /rejectsellerwd — Seller payouts\n` +
      `/revokeseller <id> — Revoke seller access\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ── Optional Express health check ─────────────────────────────────────────
if (process.env.PORT) {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.listen(process.env.PORT, () => logger.info(`Health check on port ${process.env.PORT}`));
}

// ── Startup ────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDB();

    // Seed super admin documents
    const User = require('./models/User');
    for (const id of superAdminIds) {
      await User.findOneAndUpdate(
        { telegramId: id },
        {
          $setOnInsert: {
            telegramId: id,
            name: 'Super Admin',
            role: 'superadmin',
            status: 'active',
          },
        },
        { upsert: true }
      );
    }

    initCronJobs(bot);

    await bot.launch();
    logger.info('🤖 Telegram Subscription Bot v2.0 started!');

    process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
};

start();
