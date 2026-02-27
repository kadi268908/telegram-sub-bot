// src/bot/superAdminHandlers.js
// Super admin: plan/offer/admin management, broadcast, reports, stats, planstats

const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const AdminLog = require('../models/AdminLog');
const {
  addAdmin, removeAdmin, createPlan, updatePlan, deletePlan,
  getAllPlans, getActivePlans, createOffer, deleteOffer, getActiveOffers
} = require('../services/adminService');
const { getSalesReport, getTodayExpiryList } = require('../services/subscriptionService');
const { getGrowthStats, getPlanPerformance } = require('../services/analyticsService');
const { logToChannel } = require('../services/cronService');
const { safeSend } = require('../utils/telegramUtils');
const { formatDate, startOfToday, endOfToday, startOfWeek, startOfMonth } = require('../utils/dateUtils');
const logger = require('../utils/logger');

// In-memory session for broadcast flow
const sessions = {};

const requireSuperAdmin = async (ctx, next) => {
  const superAdminIds = String(process.env.SUPER_ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(Boolean);

  if (!superAdminIds.includes(ctx.from.id)) {
    return ctx.reply('⛔ Super Admin access required.');
  }
  return next();
};

const registerSuperAdminHandlers = (bot) => {

  // ── Admin management ───────────────────────────────────────────────────────
  bot.command('addadmin', requireSuperAdmin, async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Usage: /addadmin <telegramId>');
    try {
      const user = await addAdmin(id);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'add_admin', targetUserId: id, details: {} });
      await logToChannel(bot, `👑 Admin Added: \`${id}\` (@${user.username || 'N/A'})`);
      await ctx.reply(`✅ *${user.name}* is now an Admin.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('removeadmin', requireSuperAdmin, async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Usage: /removeadmin <telegramId>');
    try {
      const user = await removeAdmin(id);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'remove_admin', targetUserId: id, details: {} });
      await ctx.reply(`✅ *${user.name}* is no longer an Admin.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('admins', requireSuperAdmin, async (ctx) => {
    const admins = await User.find({ role: 'admin' });
    if (!admins.length) return ctx.reply('No admins found.');
    let msg = '👑 *Admin List*\n\n';
    admins.forEach((a, i) => {
      msg += `${i + 1}. ${a.name} — \`${a.telegramId}\`${a.username ? ' (@' + a.username + ')' : ''}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Plan management ────────────────────────────────────────────────────────
  // /createplan Name|days|price
  bot.command('createplan', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/createplan', '').trim();
    const [name, days, price] = text.split('|').map(s => s.trim());
    if (!name || !days) return ctx.reply('Usage: `/createplan Name|days|price`', { parse_mode: 'Markdown' });
    try {
      const plan = await createPlan({ name, durationDays: parseInt(days), price: price ? parseFloat(price) : 0 });
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'create_plan', details: { planId: plan._id, name } });
      await ctx.reply(`✅ Plan created: *${plan.name}* (${plan.durationDays} days)\nID: \`${plan._id}\``, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  // /editplan id|field|value
  bot.command('editplan', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/editplan', '').trim();
    const [planId, field, value] = text.split('|').map(s => s.trim());
    if (!planId || !field || !value) return ctx.reply('Usage: `/editplan id|field|value`', { parse_mode: 'Markdown' });
    try {
      const updates = { [field]: isNaN(value) ? value : parseFloat(value) };
      const plan = await updatePlan(planId, updates);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'edit_plan', details: { planId, field, value } });
      await ctx.reply(`✅ Plan *${plan.name}* updated.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('deleteplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /deleteplan <planId>');
    try {
      await deletePlan(planId);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'delete_plan', details: { planId } });
      await ctx.reply('✅ Plan deleted.');
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('pauseplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /pauseplan <planId>');
    try {
      const plan = await Plan.findByIdAndUpdate(planId, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
      await ctx.reply(`✅ Plan *${plan.name}* is now ${plan.isActive ? '✅ Active' : '⏸ Paused'}.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('listplans', requireSuperAdmin, async (ctx) => {
    const plans = await getAllPlans();
    if (!plans.length) return ctx.reply('No plans found.');
    let msg = '📋 *All Plans*\n\n';
    plans.forEach((p, i) => {
      msg += `${i + 1}. *${p.name}* — ${p.durationDays} days — ₹${p.price} — ${p.isActive ? '✅' : '⏸'}\n   \`${p._id}\`\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Offer management ───────────────────────────────────────────────────────
  // /addoffer Title|Desc|DD/MM/YYYY|discount%
  bot.command('addoffer', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/addoffer', '').trim();
    const [title, description, dateStr, discount] = text.split('|').map(s => s.trim());
    if (!title || !description || !dateStr) {
      return ctx.reply('Usage: `/addoffer Title|Description|DD/MM/YYYY|discountPercent`', { parse_mode: 'Markdown' });
    }
    try {
      const [d, m, y] = dateStr.split('/');
      const offer = await createOffer({
        title, description,
        validTill: new Date(`${y}-${m}-${d}`),
        discountPercent: discount ? parseInt(discount) : 0,
        createdBy: ctx.from.id,
      });
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'create_offer', details: { offerId: offer._id, title } });
      await ctx.reply(`✅ Offer created: *${offer.title}*`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('deleteoffer', requireSuperAdmin, async (ctx) => {
    const offerId = ctx.message.text.split(' ')[1];
    if (!offerId) return ctx.reply('Usage: /deleteoffer <offerId>');
    try {
      await deleteOffer(offerId);
      await ctx.reply('✅ Offer deleted.');
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('listoffers', requireSuperAdmin, async (ctx) => {
    const offers = await getActiveOffers();
    if (!offers.length) return ctx.reply('No active offers.');
    let msg = '🎁 *Active Offers*\n\n';
    offers.forEach((o, i) => {
      msg += `${i + 1}. *${o.title}*\n${o.description}\nValid till: ${formatDate(o.validTill)}\n\`${o._id}\`\n\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /broadcast ─────────────────────────────────────────────────────────────
  bot.command('broadcast', requireSuperAdmin, async (ctx) => {
    await ctx.reply('📢 *Broadcast — Choose Target:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 All Users', callback_data: 'bc_all' }, { text: '✅ Active', callback_data: 'bc_active' }],
          [{ text: '❌ Expired', callback_data: 'bc_expired' }, { text: '🆕 New (last 3 days)', callback_data: 'bc_new' }],
        ],
      },
    });
  });

  bot.action(/^bc_(all|active|expired|new)$/, requireSuperAdmin, async (ctx) => {
    await ctx.answerCbQuery();
    sessions[ctx.from.id] = { action: 'broadcast', target: ctx.match[1] };
    await ctx.reply(`📝 Type your broadcast message for *${ctx.match[1]}* users.\nSend /cancel to abort.`, { parse_mode: 'Markdown' });
  });

  // ── /reports ───────────────────────────────────────────────────────────────
  bot.command('reports', requireSuperAdmin, async (ctx) => {
    await ctx.reply('📊 *Reports — Choose Type:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Daily Sales', callback_data: 'report_daily' }, { text: '📆 Weekly', callback_data: 'report_weekly' }],
          [{ text: '🗓 Monthly', callback_data: 'report_monthly' }, { text: '📋 Today Expiry', callback_data: 'report_expiry' }],
          [{ text: '✅ Active Users', callback_data: 'report_active' }, { text: '❌ Expired Users', callback_data: 'report_expired' }],
        ],
      },
    });
  });

  bot.action(/^report_(daily|weekly|monthly|expiry|active|expired)$/, requireSuperAdmin, async (ctx) => {
    await ctx.answerCbQuery('Generating...');
    const type = ctx.match[1];
    try {
      let message = '';
      if (type === 'daily') {
        message = formatSalesReport('📅 Daily Sales', await getSalesReport(startOfToday(), endOfToday()));
      } else if (type === 'weekly') {
        message = formatSalesReport('📆 Weekly Sales', await getSalesReport(startOfWeek(), new Date()));
      } else if (type === 'monthly') {
        message = formatSalesReport('🗓 Monthly Sales', await getSalesReport(startOfMonth(), new Date()));
      } else if (type === 'expiry') {
        const list = await getTodayExpiryList();
        message = `📋 *Today's Expiry List* (${list.length})\n\n`;
        list.forEach((s, i) => { message += `${i + 1}. \`${s.telegramId}\` — ${s.planName}\n`; });
        if (!list.length) message += 'No expirations today.';
      } else if (type === 'active') {
        const c = await Subscription.countDocuments({ status: 'active', expiryDate: { $gt: new Date() } });
        message = `✅ *Active Subscriptions:* ${c}`;
      } else if (type === 'expired') {
        const c = await Subscription.countDocuments({ status: 'expired' });
        message = `❌ *Total Expired:* ${c}`;
      }
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply('❌ Error generating report.');
      logger.error(`report error: ${err.message}`);
    }
  });

  // ── /stats — growth dashboard ──────────────────────────────────────────────
  bot.command('stats', requireSuperAdmin, async (ctx) => {
    try {
      const s = await getGrowthStats();
      await ctx.reply(
        `📈 *Growth Dashboard*\n\n` +
        `👥 Total Users: *${s.total}*\n` +
        `✅ Active: *${s.active}*\n` +
        `❌ Expired: *${s.expired}*\n` +
        `🚫 Blocked: *${s.blocked}*\n` +
        `🆕 New Today: *${s.newToday}*\n` +
        `🔄 Renewals Today: *${s.renewalsToday}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply('❌ Error fetching stats.');
    }
  });

  // ── /planstats — plan performance ─────────────────────────────────────────
  bot.command('planstats', requireSuperAdmin, async (ctx) => {
    try {
      const data = await getPlanPerformance();
      if (!data.length) return ctx.reply('No active subscriptions found.');

      let msg = '📊 *Plan Performance*\n\n';
      data.forEach(row => {
        msg += `📋 *${row.planName}* (${row.durationDays} days): *${row.count}* active users\n`;
      });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply('❌ Error fetching plan stats.');
    }
  });

  // ── /adminlogs — recent admin activity ────────────────────────────────────
  bot.command('adminlogs', requireSuperAdmin, async (ctx) => {
    const logs = await AdminLog.find({}).sort({ timestamp: -1 }).limit(15);
    if (!logs.length) return ctx.reply('No admin logs found.');
    let msg = '📋 *Recent Admin Actions*\n\n';
    logs.forEach(l => {
      msg += `• \`${l.actionType}\` by \`${l.adminId}\``;
      if (l.targetUserId) msg += ` → \`${l.targetUserId}\``;
      msg += `\n  ${new Date(l.timestamp).toLocaleString('en-GB')}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /cancel ────────────────────────────────────────────────────────────────
  bot.command('cancel', requireSuperAdmin, async (ctx) => {
    if (sessions[ctx.from.id]) {
      delete sessions[ctx.from.id];
      await ctx.reply('✅ Cancelled.');
    }
  });

  // ── Text handler: broadcast message capture ───────────────────────────────
  bot.on('text', async (ctx, next) => {
    const session = sessions[ctx.from.id];
    if (!session || session.action !== 'broadcast') return next();
    delete sessions[ctx.from.id];

    const { target } = session;
    const message = ctx.message.text;

    let filter = { role: 'user', isBlocked: false };
    if (target === 'active') filter.status = 'active';
    else if (target === 'expired') filter.status = 'expired';
    else if (target === 'new') {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: threeDaysAgo };
    }

    const users = await User.find(filter);
    await ctx.reply(`📤 Sending to *${users.length}* users...`, { parse_mode: 'Markdown' });

    let sent = 0, failed = 0;
    for (const user of users) {
      const ok = await safeSend(bot, user.telegramId, message);
      ok ? sent++ : failed++;
      await new Promise(r => setTimeout(r, 50)); // rate limit throttle
    }

    const summary = `📢 *Broadcast Complete*\n✅ Sent: ${sent}\n❌ Failed: ${failed}\nTarget: ${target}`;
    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await logToChannel(bot, summary);

    await AdminLog.create({
      adminId: ctx.from.id,
      actionType: 'broadcast',
      details: { target, sent, failed, message: message.substring(0, 100) },
    });
  });
};

const formatSalesReport = (title, data) => {
  if (!data.length) return `${title}\n\nNo data found.`;
  let msg = `*${title}*\n\n`;
  let totalSubs = 0, totalRevenue = 0;
  data.forEach(r => {
    msg += `📋 *${r.planName}*: ${r.count} subs — ₹${r.totalRevenue.toFixed(2)}\n`;
    totalSubs += r.count;
    totalRevenue += r.totalRevenue;
  });
  msg += `\n📊 Total: ${totalSubs} — ₹${totalRevenue.toFixed(2)}`;
  return msg;
};

module.exports = { registerSuperAdminHandlers };
