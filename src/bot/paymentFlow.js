const { getUserFlowState } = require('../utils/userFlowState');

const PAYMENT_PROOF_SPAM_WINDOW_MINUTES = Math.max(1, parseInt(process.env.PAYMENT_PROOF_SPAM_WINDOW_MINUTES || '10', 10));
const PAYMENT_PROOF_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.PAYMENT_PROOF_MAX_ATTEMPTS || '5', 10));
const PAYMENT_PROOF_COOLDOWN_MINUTES = Math.max(1, parseInt(process.env.PAYMENT_PROOF_COOLDOWN_MINUTES || '30', 10));

const registerPaymentFlow = ({
    bot,
    fs,
    path,
    User,
    Request,
    Subscription,
    Plan,
    Markup,
    withStyle,
    logger,
    PLAN_CATEGORY,
    QR_ASSET_BY_CATEGORY,
    normalizePlanCategory,
    getPlanCategoryLabel,
    buildCategoryPlansText,
    buildSetUserFlowUpdate,
    USER_FLOW_STATE,
    escapeMarkdown,
    findOrCreateUser,
    getBestPublicOffer,
    getDiscountedPrice,
    formatInr,
    consumeOneTimeUserOffer,
    submitPremiumRequest,
    getActiveTicket,
}) => {
    bot.action(/^plan_menu_(movie|desi|non_desi|movie_desi|movie_non_desi)$/, async (ctx) => {
        await ctx.answerCbQuery();
        try {
            const category = normalizePlanCategory(ctx.match[1]);
            const plansText = await buildCategoryPlansText(category);
            const activeCategorySub = await Subscription.findOne({
                telegramId: ctx.from.id,
                status: 'active',
                expiryDate: { $gt: new Date() },
                planCategory: category,
            });
            const plansMessage = activeCategorySub
                ? `${plansText}\n\n✅ You already have an active ${getPlanCategoryLabel(category)} subscription.\nIf you want to extend it, click *Renew*.`
                : plansText;
            const qrFileName = QR_ASSET_BY_CATEGORY[category];
            const qrPath = path.join(process.cwd(), 'assets', qrFileName);
            const paidRows = [];
            if (activeCategorySub) {
                paidRows.push([withStyle(Markup.button.callback(`🔄 Renew ${getPlanCategoryLabel(category)}`, `status_renew_${category}`), 'success')]);
            }
            paidRows.push([withStyle(Markup.button.callback('✅ Paid', `paid_${category}`), 'success')]);
            paidRows.push([withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')]);
            const paidKeyboard = Markup.inlineKeyboard(paidRows);

            if (fs.existsSync(qrPath)) {
                await ctx.replyWithPhoto(
                    { source: qrPath },
                    {
                        caption: plansMessage,
                        ...paidKeyboard,
                    }
                );
            } else {
                await ctx.reply(
                    `${plansMessage}\n\n⚠️ QR image missing: ${qrFileName} (assets folder).`,
                    {
                        ...paidKeyboard,
                    }
                );
            }
        } catch (err) {
            logger.error(`plan_menu error: ${err.message}`);
            await ctx.reply('❌ Plan fetch failed. Please try again.');
        }
    });

    bot.action(/^paid_(movie|desi|non_desi|movie_desi|movie_non_desi)$/, async (ctx) => {
        await ctx.answerCbQuery();
        try {
            const callbackMessageId = ctx.callbackQuery?.message?.message_id;
            const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
            const category = normalizePlanCategory(ctx.match[1]);
            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                buildSetUserFlowUpdate(
                    USER_FLOW_STATE.AWAITING_PAYMENT_SCREENSHOT,
                    {
                        'meta.paymentCategory': category,
                        'meta.paymentFlowType': 'new_request',
                    },
                    {
                        'meta.paymentProofReadyForCategory': '',
                        'meta.renewalPlanId': '',
                    }
                ),
                { upsert: false }
            );

            await ctx.reply(
                `📸 *Payment screenshot upload karein*\n\n` +
                `Aapne *${escapeMarkdown(getPlanCategoryLabel(category))}* select kiya hai.\n` +
                `Ab payment screenshot photo/document bhejiye.` +
                `🚫 Agar aapne fake screenshot upload kiya to aap hamesha k liye ban ho jaogye.\n\n`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [withStyle(Markup.button.callback('❌ Cancel Upload', 'cancel_payment_upload'), 'danger')],
                        [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
                    ]),
                }
            );

            if (callbackChatId && callbackMessageId) {
                await ctx.telegram.deleteMessage(callbackChatId, callbackMessageId).catch(() => { });
            }
        } catch (err) {
            logger.error(`paid action error: ${err.message}`);
            await ctx.reply('❌ Unable to process. Please try again.');
        }
    });

    bot.action('cancel_payment_upload', async (ctx) => {
        await ctx.answerCbQuery('Upload cancelled');
        try {
            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                buildSetUserFlowUpdate(
                    USER_FLOW_STATE.IDLE,
                    {},
                    {
                        'meta.paymentCategory': '',
                        'meta.paymentProofReadyForCategory': '',
                        'meta.paymentFlowType': '',
                        'meta.renewalPlanId': '',
                    }
                )
            );

            await ctx.reply(
                `✅ Screenshot upload mode cancelled.\n\n` +
                `Aap dubara plan choose karke continue kar sakte hain.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [withStyle(Markup.button.callback('📋 Check Plans', 'check_plans'), 'success')],
                        [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
                    ]),
                }
            );
        } catch (err) {
            logger.error(`cancel_payment_upload error: ${err.message}`);
            await ctx.reply('❌ Unable to cancel upload mode right now. Please try again.');
        }
    });

    bot.action(/^renew_request_(?:(movie|desi|non_desi|movie_desi|movie_non_desi)_)?(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Continue with payment screenshot...');
        try {
            const categoryFromCallback = normalizePlanCategory(ctx.match[1] || PLAN_CATEGORY.GENERAL);
            const planId = ctx.match[2];
            const user = await findOrCreateUser(ctx.from);
            await User.findByIdAndUpdate(user._id, { lastInteraction: new Date() });

            const plan = await Plan.findById(planId);
            if (!plan) return ctx.reply('❌ Plan not found. Please try again.');

            const renewalCategory = normalizePlanCategory(plan.category || categoryFromCallback);
            if (ctx.match[1] && renewalCategory !== categoryFromCallback) {
                return ctx.reply('❌ Selected plan category mismatch. Please retry renewal from status.');
            }

            const activeOrGraceSub = await Subscription.findOne({
                telegramId: ctx.from.id,
                status: { $in: ['active', 'grace'] },
                planCategory: renewalCategory,
            });
            if (!activeOrGraceSub) {
                return ctx.reply(
                    `⚠️ Aapke paas *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))}* ka active/grace subscription nahi hai.\n\n` +
                    `Renew karne ke liye pehle us category ka active plan hona chahiye.`,
                    { parse_mode: 'Markdown' }
                );
            }

            const existingPending = await Request.findOne({
                telegramId: ctx.from.id,
                status: 'pending',
                requestCategory: renewalCategory,
            });
            if (existingPending) {
                return ctx.reply(
                    `⏳ *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))} renewal pending hai!*\n\n` +
                    `Admin approval ka wait kijiye.`,
                    { parse_mode: 'Markdown' }
                );
            }

            await User.findByIdAndUpdate(
                user._id,
                buildSetUserFlowUpdate(
                    USER_FLOW_STATE.AWAITING_PAYMENT_SCREENSHOT,
                    {
                        'meta.paymentCategory': renewalCategory,
                        'meta.paymentFlowType': 'renewal',
                        'meta.renewalPlanId': String(plan._id),
                    },
                    {
                        'meta.paymentProofReadyForCategory': '',
                        'meta.latestPaymentProof': '',
                    }
                )
            );

            const callbackMessageId = ctx.callbackQuery?.message?.message_id;
            const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
            const bestOffer = await getBestPublicOffer();
            const discountedRenewalPrice = bestOffer?.discountPercent > 0
                ? getDiscountedPrice(plan.price, bestOffer.discountPercent)
                : plan.price;

            await ctx.reply(
                `📸 *Renewal Payment Screenshot Upload Karein*\n\n` +
                `Category: *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))}*\n` +
                `Plan: *${escapeMarkdown(plan.name)}* (${plan.durationDays} days${plan.price ? ` · ₹${formatInr(plan.price)}` : ''})\n` +
                (plan.price && bestOffer?.discountPercent > 0
                    ? `🎁 Offer: *${escapeMarkdown(bestOffer.title)}* (${bestOffer.discountPercent}% OFF)\n` +
                    `💰 Payable: *₹${formatInr(discountedRenewalPrice)}*\n\n`
                    : '\n') +
                `Ab payment screenshot photo/document bhejiye.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [withStyle(Markup.button.callback('❌ Cancel Upload', 'cancel_payment_upload'), 'danger')],
                        [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
                    ]),
                }
            );

            if (callbackChatId && callbackMessageId) {
                await ctx.telegram.deleteMessage(callbackChatId, callbackMessageId).catch(() => { });
            }
        } catch (err) {
            logger.error(`renew_request error: ${err.message}`);
        }
    });

    const onPaymentProofReceived = async (ctx, sourceType) => {
        if (ctx.chat?.type !== 'private') return;

        const userDoc = await User.findOne({ telegramId: ctx.from.id });
        if (getUserFlowState(userDoc) !== USER_FLOW_STATE.AWAITING_PAYMENT_SCREENSHOT) return;

        const now = Date.now();
        const rateInfo = userDoc?.meta?.paymentProofRateLimit || {};
        const blockedUntilMs = rateInfo?.blockedUntil ? new Date(rateInfo.blockedUntil).getTime() : 0;
        if (blockedUntilMs && now < blockedUntilMs) {
            const unblockTime = new Date(blockedUntilMs).toLocaleString('en-IN');
            await ctx.reply(
                `⏳ Screenshot upload temporarily paused due to too many attempts.\n\n` +
                `Please try again after: *${escapeMarkdown(unblockTime)}*`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const windowStartMs = rateInfo?.windowStart ? new Date(rateInfo.windowStart).getTime() : 0;
        const isInsideWindow = windowStartMs && (now - windowStartMs) < PAYMENT_PROOF_SPAM_WINDOW_MINUTES * 60 * 1000;
        const nextCount = isInsideWindow ? Number(rateInfo?.count || 0) + 1 : 1;
        const nextWindowStart = isInsideWindow ? new Date(windowStartMs) : new Date(now);

        if (nextCount > PAYMENT_PROOF_MAX_ATTEMPTS) {
            const cooldownUntil = new Date(now + PAYMENT_PROOF_COOLDOWN_MINUTES * 60 * 1000);
            await User.findOneAndUpdate(
                { telegramId: ctx.from.id },
                {
                    $set: {
                        'meta.paymentProofRateLimit': {
                            windowStart: nextWindowStart,
                            count: nextCount,
                            blockedUntil: cooldownUntil,
                        },
                    },
                }
            );

            logger.warn(`Payment proof cooldown applied for ${ctx.from.id} until ${cooldownUntil.toISOString()}`);
            await ctx.reply(
                `🚫 Too many screenshot attempts detected.\n\n` +
                `Please wait *${PAYMENT_PROOF_COOLDOWN_MINUTES} minutes* and try again.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        await User.findOneAndUpdate(
            { telegramId: ctx.from.id },
            {
                $set: {
                    'meta.paymentProofRateLimit': {
                        windowStart: nextWindowStart,
                        count: nextCount,
                        blockedUntil: null,
                    },
                },
            }
        );

        const category = normalizePlanCategory(userDoc?.meta?.paymentCategory);
        const paymentFlowType = String(userDoc?.meta?.paymentFlowType || 'new_request');
        const renewalPlanId = userDoc?.meta?.renewalPlanId || null;
        const categoryLabel = getPlanCategoryLabel(category);
        const safeName = escapeMarkdown(userDoc.name || ctx.from.first_name || 'User');
        const safeUsername = userDoc.username ? `@${escapeMarkdown(userDoc.username)}` : 'N/A';

        let fileId;
        let fileUniqueId;

        if (sourceType === 'photo') {
            const photos = ctx.message?.photo || [];
            const bestPhoto = photos[photos.length - 1];
            fileId = bestPhoto?.file_id;
            fileUniqueId = bestPhoto?.file_unique_id;
        } else {
            fileId = ctx.message?.document?.file_id;
            fileUniqueId = ctx.message?.document?.file_unique_id;
        }

        if (!fileId) {
            await ctx.reply('❌ Invalid screenshot. Please send a clear image.');
            return;
        }

        let proofLogMessageId = null;
        try {
            const caption =
                `🧾 *Payment Screenshot Submitted*\n\n` +
                `📦 Category: *${escapeMarkdown(categoryLabel)}*\n` +
                `👤 Name: ${safeName}\n` +
                `🆔 User ID: \`${ctx.from.id}\`\n` +
                `📛 Username: ${safeUsername}\n` +
                `🕒 Time: ${new Date().toLocaleString('en-IN')}`;

            const logMessage = sourceType === 'photo'
                ? await bot.telegram.sendPhoto(process.env.LOG_CHANNEL_ID, fileId, { caption, parse_mode: 'Markdown' })
                : await bot.telegram.sendDocument(process.env.LOG_CHANNEL_ID, fileId, { caption, parse_mode: 'Markdown' });

            proofLogMessageId = logMessage?.message_id || null;
        } catch (err) {
            logger.error(`payment proof log error: ${err.message}`);
        }

        if (paymentFlowType === 'renewal' && renewalPlanId) {
            const user = await findOrCreateUser(ctx.from);
            const plan = await Plan.findById(renewalPlanId);
            if (!plan) {
                await User.findOneAndUpdate(
                    { telegramId: ctx.from.id },
                    buildSetUserFlowUpdate(
                        USER_FLOW_STATE.IDLE,
                        {},
                        {
                            'meta.paymentCategory': '',
                            'meta.paymentFlowType': '',
                            'meta.renewalPlanId': '',
                        }
                    )
                );
                await ctx.reply('❌ Renewal plan not found. Please open status and retry renewal.');
                return;
            }

            const renewalCategory = normalizePlanCategory(plan.category || category);
            if (renewalCategory !== category) {
                await User.findOneAndUpdate(
                    { telegramId: ctx.from.id },
                    buildSetUserFlowUpdate(
                        USER_FLOW_STATE.IDLE,
                        {},
                        {
                            'meta.paymentCategory': '',
                            'meta.paymentFlowType': '',
                            'meta.renewalPlanId': '',
                        }
                    )
                );
                await ctx.reply('❌ Renewal category mismatch. Please retry renewal from status.');
                return;
            }

            const existingPending = await Request.findOne({
                telegramId: ctx.from.id,
                status: 'pending',
                requestCategory: renewalCategory,
            });
            if (existingPending) {
                await User.findOneAndUpdate(
                    { telegramId: ctx.from.id },
                    buildSetUserFlowUpdate(
                        USER_FLOW_STATE.IDLE,
                        {},
                        {
                            'meta.paymentCategory': '',
                            'meta.paymentFlowType': '',
                            'meta.renewalPlanId': '',
                        }
                    )
                );
                await ctx.reply(
                    `⏳ *${escapeMarkdown(getPlanCategoryLabel(renewalCategory))} renewal pending hai!*\n\n` +
                    `Admin approval ka wait kijiye.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const renewalReq = await Request.create({
                userId: user._id,
                telegramId: ctx.from.id,
                status: 'pending',
                requestCategory: renewalCategory,
                selectedPlanId: plan._id,
                paymentProof: {
                    fileId,
                    fileUniqueId,
                    sourceType,
                    logMessageId: proofLogMessageId,
                },
            });

            const consumedOffer = await consumeOneTimeUserOffer(ctx.from.id, renewalReq._id);
            const bestOffer = await getBestPublicOffer();
            if (consumedOffer) {
                await Request.findByIdAndUpdate(renewalReq._id, {
                    appliedUserOffer: {
                        offerId: consumedOffer._id,
                        title: consumedOffer.title,
                        discountPercent: consumedOffer.discountPercent,
                    },
                });
            }

            await User.findByIdAndUpdate(user._id, {
                ...buildSetUserFlowUpdate(
                    USER_FLOW_STATE.IDLE,
                    {},
                    {
                        'meta.latestPaymentProof': '',
                        'meta.paymentProofReadyForCategory': '',
                        'meta.paymentCategory': '',
                        'meta.paymentFlowType': '',
                        'meta.renewalPlanId': '',
                    }
                ),
            });

            await ctx.reply(
                `✅ *${escapeMarkdown(categoryLabel)} renewal request submitted!*\n\n` +
                `📋 Plan: *${escapeMarkdown(plan.name)}* (${plan.durationDays} days${plan.price ? ` · ₹${formatInr(plan.price)}` : ''})\n` +
                (plan.price && bestOffer?.discountPercent > 0
                    ? `🎁 *Public offer applied:* ${escapeMarkdown(bestOffer.title)} (${bestOffer.discountPercent}% OFF)\n` +
                    `💰 Price: ~₹${formatInr(plan.price)}~ → *₹${formatInr(getDiscountedPrice(plan.price, bestOffer.discountPercent))}*\n\n`
                    : '\n') +
                (consumedOffer
                    ? `🎁 *Private offer applied:* ${escapeMarkdown(consumedOffer.title)}${consumedOffer.discountPercent > 0 ? ` (*${consumedOffer.discountPercent}% OFF*)` : ''}\n\n`
                    : '') +
                `Admin screenshot verify karke approval denge. Approval ke baad isi category plan me days add honge.`,
                { parse_mode: 'Markdown' }
            );

            const safePlanName = escapeMarkdown(plan.name);
            const logMsg = await bot.telegram.sendMessage(
                process.env.LOG_CHANNEL_ID,
                `🔄 *Renewal Request*\n\n` +
                `📦 Category: *${escapeMarkdown(categoryLabel)}*\n` +
                `👤 Name: ${safeName}\n` +
                `🆔 ID: \`${ctx.from.id}\`\n` +
                `📛 Username: ${safeUsername}\n` +
                (plan.price && bestOffer?.discountPercent > 0
                    ? `🎁 Public Offer: *${escapeMarkdown(bestOffer.title)}* (${bestOffer.discountPercent}% OFF)\n` +
                    `💰 Price: ~₹${formatInr(plan.price)}~ → *₹${formatInr(getDiscountedPrice(plan.price, bestOffer.discountPercent))}*\n`
                    : '') +
                (consumedOffer
                    ? `🎁 Private Offer: *${escapeMarkdown(consumedOffer.title)}*${consumedOffer.discountPercent > 0 ? ` (*${consumedOffer.discountPercent}% OFF*)` : ''}\n`
                    : '') +
                `📋 Plan: ${safePlanName} (${plan.durationDays} days${plan.price ? ` · ₹${formatInr(plan.price)}` : ''})\n` +
                `🧾 Payment Proof Log Msg: \`${proofLogMessageId || 'N/A'}\`\n` +
                `🕒 Time: ${new Date().toLocaleString('en-IN')}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            withStyle({ text: '✅ Approve', callback_data: `approve_${renewalReq._id}_${plan._id}` }, 'success'),
                            withStyle({ text: '❌ Reject', callback_data: `reject_${renewalReq._id}` }, 'danger'),
                        ]],
                    },
                }
            );

            await Request.findByIdAndUpdate(renewalReq._id, { logMessageId: logMsg.message_id });
            return;
        }

        await User.findOneAndUpdate(
            { telegramId: ctx.from.id },
            buildSetUserFlowUpdate(
                USER_FLOW_STATE.AWAITING_PAYMENT_SCREENSHOT,
                {
                    'meta.paymentProofReadyForCategory': category,
                    'meta.latestPaymentProof': {
                        fileId,
                        fileUniqueId,
                        sourceType,
                        logMessageId: proofLogMessageId,
                        category,
                        uploadedAt: new Date(),
                    },
                },
            )
        );

        await submitPremiumRequest(ctx, category);
    };

    const maybePromptCheckPlansBeforeScreenshot = async (ctx) => {
        if (ctx.chat?.type !== 'private') return false;

        const userId = ctx.from?.id;
        if (!userId) return false;

        const userDoc = await User.findOne({ telegramId: userId });
        if (getUserFlowState(userDoc) === USER_FLOW_STATE.AWAITING_PAYMENT_SCREENSHOT) return false;

        const isAwaitingSupport = userDoc?.meta?.awaitingSupport === true;
        if (isAwaitingSupport) return false;

        const activeTicket = await getActiveTicket(userId);
        if (activeTicket) return false;

        await ctx.reply(
            `⚠️ Screenshot upload karne se pehle *Check Plans* me category select karein.\n\n` +
            `Flow: *Check Plans* → category choose karein → *Paid* dabayein → screenshot upload karein.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [withStyle(Markup.button.callback('📋 Check Plans', 'check_plans'), 'success')],
                    [withStyle(Markup.button.callback('🏠 Main Menu', 'back_to_main'), 'primary')],
                ]),
            }
        );

        return true;
    };

    bot.on('photo', async (ctx, next) => {
        try {
            if (await maybePromptCheckPlansBeforeScreenshot(ctx)) return next();
            await onPaymentProofReceived(ctx, 'photo');
        } catch (err) {
            logger.error(`payment proof photo handler error: ${err.message}`);
            await ctx.reply('❌ Screenshot process failed. Please try again.');
        }
        return next();
    });

    bot.on('document', async (ctx, next) => {
        try {
            const mime = String(ctx.message?.document?.mime_type || '').toLowerCase();
            if (!mime.startsWith('image/')) return next();
            if (await maybePromptCheckPlansBeforeScreenshot(ctx)) return next();
            await onPaymentProofReceived(ctx, 'document');
        } catch (err) {
            logger.error(`payment proof document handler error: ${err.message}`);
            await ctx.reply('❌ Screenshot process failed. Please try again.');
        }
        return next();
    });
};

module.exports = { registerPaymentFlow };
