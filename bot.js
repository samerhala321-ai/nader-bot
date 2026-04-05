const { Telegraf, Markup } = require('telegraf');
const ccxt = require('ccxt');
const fs = require('fs');
const http = require('http');

// --- إضافة سطر السيرفر لضمان عمل البوت أونلاين على Render/Koyeb ---
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Nader Bot V100 is Running Online!\n');
}).listen(process.env.PORT || 3000);

const BOT_TOKEN = '8685761250:AAFXT9Kn6afYbs2hd_F3EJ-O8PvCSl1sWBI';
const bot = new Telegraf(BOT_TOKEN);
const exchange = new ccxt.okx({ enableRateLimit: true });

let lastChatId = null;
let isScanning = true;
let btcAlertSent = false;
let topGainers = []; 
let lastRadarTime = 0;

let wallet = { total: 100.00, cash: 0.00, trading: 100.00, history: [] }; 
let trades = {}; 
let cooldowns = {}; 

if (fs.existsSync('data.json')) {
    try {
        const data = JSON.parse(fs.readFileSync('data.json'));
        trades = data.trades || {};
        wallet = data.wallet || wallet;
        lastChatId = data.lastChatId || null;
        cooldowns = data.cooldowns || {};
    } catch (e) { console.error("Error loading data:", e.message); }
}

function save() { 
    let usedInActive = 0;
    for (const s in trades) { if (trades[s].isActive) usedInActive += trades[s].totalSpent; }
    wallet.total = (wallet.cash || 0) + (wallet.trading || 0) + usedInActive;
    try {
        fs.writeFileSync('data.json', JSON.stringify({ trades, wallet, lastChatId, cooldowns }, null, 2)); 
    } catch (e) { console.error("Error saving data:", e.message); }
}

const formatDuration = (ms) => {
    if (!ms) return "[ 00 : 00 ]";
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    const hStr = String(hours).padStart(2, '0');
    const mStr = String(minutes).padStart(2, '0');

    return `[ ${mStr} : ${hStr} ]`;
};

const getMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('🟢 حالة الصفقات', 'track_active'), Markup.button.callback('🟢 وضع السوق', 'market_status')],
    [Markup.button.callback('🟢 للمحفظة', 'get_wallet'), Markup.button.callback('🟢 تقرير الأداء', 'report')],
    [Markup.button.callback('🟢 اختبار الأداء', 'test_perf'), Markup.button.callback('🚨 إغلاق إجباري', 'force_close_confirm')],
    [Markup.button.callback(isScanning ? '🛑 قفل البوت' : '🚀 تشغيل البوت', 'toggle_scan')]
]);

function canEnterCoin(symbol) {
    const now = Date.now();
    if (cooldowns[symbol] && (now - cooldowns[symbol]) < (30 * 60 * 1000)) return false;
    const twelveHoursAgo = now - (12 * 60 * 60 * 1000);
    const coinSymbol = symbol.split('/')[0];
    const recentWins = wallet.history.filter(h => h.s === coinSymbol && h.p > 0 && h.time && h.time > twelveHoursAgo);
    return recentWins.length < 4;
}

function closeTrade(symbol, finalDiff, reason, exitPrice = 0) {
    try {
        const trade = trades[symbol];
        if (!trade || !trade.isActive) return;
        const fee = trade.totalSpent * 0.002; 
        const profitUsd = (trade.totalSpent * (finalDiff / 100)) - fee;
        const entryPrice = trade.averagePrice;
        const coinName = symbol.split('/')[0];
        const durationMs = Date.now() - trade.startTime;

        wallet.history.push({ s: coinName, p: finalDiff, v: profitUsd, time: Date.now(), d: durationMs, lvl: trade.levels });
        wallet.trading += (trade.totalSpent + profitUsd);
        
        trade.isActive = false;
        cooldowns[symbol] = Date.now(); 
        save();

        if (lastChatId) {
            let msg = `✅ **تم بيع صفقة: ${coinName}** (${reason})\n`;
            msg += `--------------------------\n`;
            msg += `📥 متوسط الدخول: $${entryPrice.toFixed(8).replace(/\.?0+$/, '')}\n`;
            msg += `📤 سعر الخروج: $${exitPrice.toFixed(8).replace(/\.?0+$/, '')}\n`;
            msg += `📈 النتيجة: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)}%\n`;
            msg += `💰 صافي الربح: $${profitUsd.toFixed(4)}\n`;
            msg += `⏳ المدة: ${formatDuration(durationMs)}\n`;
            msg += `--------------------------`;
            bot.telegram.sendMessage(lastChatId, msg);
        }
    } catch (e) { console.error("Close Error:", e.message); }
}

async function coreEngine() {
    if (!lastChatId || !isScanning) return;
    try {
        const now = Date.now();
        if (now - lastRadarTime > 120000 || topGainers.length === 0) {
            const allTickers = await exchange.fetchTickers();
            topGainers = Object.values(allTickers)
                .filter(t => t.symbol.endsWith('/USDT') && !t.symbol.includes('BTC') && !t.symbol.includes('ETH'))
                .sort((a,b) => b.percentage - a.percentage)
                .slice(0, 50).map(t => t.symbol);
            lastRadarTime = now;
        }
        const activeSymbols = Object.keys(trades).filter(s => trades[s].isActive);
        const symbolsToWatch = [...new Set(['BTC/USDT', ...activeSymbols, ...topGainers])];
        const tickers = await exchange.fetchTickers(symbolsToWatch);
        const btc = tickers['BTC/USDT'];
        const dailyLoss = wallet.history.filter(h => now - h.time < 86400000 && h.p < 0).reduce((sum, h) => sum + Math.abs(h.v), 0);
        
        const levelsAmounts = [2.0, 3.0, 3.0, 3.0, 4.0];

        for (const symbol of activeSymbols) {
            const coin = tickers[symbol];
            if (!coin) continue;
            const diff = ((coin.last - trades[symbol].averagePrice) / trades[symbol].averagePrice) * 100;
            if (diff > (trades[symbol].highestProfit || 0)) trades[symbol].highestProfit = diff;
            
            if ((trades[symbol].highestProfit || 0) >= 3.0 && (trades[symbol].highestProfit - diff) >= 0.5) {
                closeTrade(symbol, diff, "ملاحقة", coin.last); continue;
            }
            if (trades[symbol].levelTime) {
                const hoursInLevel = (now - trades[symbol].levelTime) / (1000 * 60 * 60);
                if (hoursInLevel >= 3 && diff > 0.01) { 
                    closeTrade(symbol, diff, "خطة هروب (3 ساعات ثبات)", coin.last); continue;
                }
            }

            let triggerPercent = (trades[symbol].levels === 4) ? -4.0 : -2.0;

            if (diff <= triggerPercent && trades[symbol].levels < 5) {
                const nextStepAmount = levelsAmounts[trades[symbol].levels];
                if (wallet.trading >= nextStepAmount) {
                    wallet.trading -= nextStepAmount; 
                    trades[symbol].totalSpent += nextStepAmount;
                    trades[symbol].averagePrice = ((trades[symbol].averagePrice * (trades[symbol].totalSpent - nextStepAmount)) + (coin.last * nextStepAmount)) / trades[symbol].totalSpent;
                    trades[symbol].levels++;
                    trades[symbol].amount = trades[symbol].totalSpent / coin.last;
                    trades[symbol].levelTime = Date.now(); 
                    save();
                }
            }
        }

        if (dailyLoss > 5) return;
        if (btc && btc.percentage < -3) {
            if (!btcAlertSent) {
                bot.telegram.sendMessage(lastChatId, `⚠️ **توقف مؤقت:** البيتكوين هابط.`);
                btcAlertSent = true;
            }
            return;
        } else { btcAlertSent = false; }

        let activeCount = activeSymbols.length;
        const usedInActive = Object.values(trades).filter(t => t.isActive).reduce((sum, t) => sum + t.totalSpent, 0);
        const maxConcurrentTrades = Math.floor((wallet.trading + usedInActive) / 15.0) || 1;

        if (activeCount < maxConcurrentTrades && wallet.trading >= levelsAmounts[0]) {
            for (const symbol of topGainers) {
                if (activeCount >= maxConcurrentTrades || wallet.trading < levelsAmounts[0]) break;
                if (trades[symbol] && trades[symbol].isActive) continue;
                if (!canEnterCoin(symbol)) continue; 
                const coin = tickers[symbol];
                if (!coin) continue;
                wallet.trading -= levelsAmounts[0]; 
                trades[symbol] = { isActive: true, levels: 1, totalSpent: levelsAmounts[0], averagePrice: coin.last, highestProfit: 0, amount: levelsAmounts[0] / coin.last, levelTime: Date.now(), startTime: Date.now() };
                activeCount++; save();
                bot.telegram.sendMessage(lastChatId, `🛒 **شراء عملة جديدة:** ${symbol.split('/')[0]} بسعر $${coin.last.toFixed(8).replace(/\.?0+$/, '')}`);
            }
        }
        save();
    } catch (e) { }
}

bot.action('report', async (ctx) => {
    await ctx.answerCbQuery();
    const history = wallet.history || [];
    const now = new Date();
    
    const formatDate = (time) => {
        const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const d = new Date(time);
        const dayDiff = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
        const dayName = days[d.getDay()];
        const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;
        if (dayDiff === 0) return `📅 اليوم (${dayName} - ${dateStr})`;
        if (dayDiff === 1) return `📅 أمس (${dayName} - ${dateStr})`;
        return `📅 ${dayName} (${dateStr})`;
    };

    const groups = {};
    let totalWinV = 0, totalWinP = 0, totalLossV = 0, totalLossP = 0;

    history.forEach(h => {
        const label = formatDate(h.time);
        if (!groups[label]) groups[label] = { trades: [], winV: 0, winP: 0, lossV: 0, lossP: 0 };
        groups[label].trades.push(h);
        if (h.p > 0) { 
            groups[label].winV += h.v; groups[label].winP += h.p; 
            totalWinV += h.v; totalWinP += h.p;
        } else { 
            groups[label].lossV += Math.abs(h.v); groups[label].lossP += Math.abs(h.p); 
            totalLossV += Math.abs(h.v); totalLossP += Math.abs(h.p);
        }
    });

    let msg = `📊 **تقرير صفقات نادر:**\n--------------------------\n📝 **سجل العمليات:**\n`;
    const sortedLabels = Object.keys(groups).reverse().slice(0, 5); 
    sortedLabels.forEach(label => {
        const g = groups[label];
        msg += `${label}\n`;
        g.trades.forEach((h, i) => { 
            msg += `${i + 1}. ${h.p > 0 ? '🟢' : '🔴'} ${h.s}: ${h.p >= 0 ? '+' : ''}${h.p.toFixed(2)}% [ 5/${h.lvl || 1} ] ${formatDuration(h.d)}\n`; 
        });
        msg += `📌 **ملخص الأداء:**\n💰 ربح: +$${g.winV.toFixed(4)} (+${g.winP.toFixed(2)}%)\n💸 خسارة: -$${g.lossV.toFixed(4)} (-${g.lossP.toFixed(2)}%)\n🔄 صافي اليوم: $${(g.winV - g.lossV).toFixed(4)}\n--------------------------\n`;
    });
    
    msg += `🌍 **ملخص الأداء الكلي:**\n💰 **إجمالي الربح:** +$${totalWinV.toFixed(4)} (+${totalWinP.toFixed(2)}%)\n💸 **إجمالي الخسارة:** -$${totalLossV.toFixed(4)} (-${totalLossP.toFixed(2)}%)\n--------------------------\n🔄 **صافي الأداء:** $${(totalWinV - totalLossV).toFixed(4)}`;
    ctx.editMessageText(msg, getMenu());
});

bot.action('track_active', async (ctx) => {
    await ctx.answerCbQuery();
    let active = Object.keys(trades).filter(s => trades[s].isActive);
    if (active.length === 0) return ctx.editMessageText("⏳ لا توجد صفقات مفتوحة حالياً.", getMenu());
    let msg = "🟢 **حالة الصفقات المفتوحة:**\n";
    let buttons = [];
    const tickers = await exchange.fetchTickers(active);
    for (const s of active) {
        const t = tickers[s]; if (!t) continue;
        const diff = ((t.last - trades[s].averagePrice) / trades[s].averagePrice) * 100;
        const target = trades[s].averagePrice * 1.03;
        msg += `📈 **عملة ${s.split('/')[0]}:**\n━━━━━━━━━━━━━━━━━━━━\n📊 المستويات: ${trades[s].levels} / 5\n📉 المتوسط: $${trades[s].averagePrice.toFixed(8).replace(/\.?0+$/, '')}\n🎯 الهدف: $${target.toFixed(8).replace(/\.?0+$/, '')}\n🚦 الربح: ${diff >= 0 ? "🟢 +" : "🔴 "}${diff.toFixed(2)}%\n⏳ المدة: ${formatDuration(Date.now() - trades[s].startTime)}\n━━━━━━━━━━━━━━━━━━━━\n`;
        buttons.push([Markup.button.callback(`❌ إغلاق ${s.split('/')[0]} يدويًا`, `ASK_CLOSE_${s.replace('/', '_')}`)]);
    }
    buttons.push([Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')]);
    ctx.editMessageText(msg, Markup.inlineKeyboard(buttons));
});

bot.action(/^ASK_CLOSE_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const symbol = ctx.match[1].replace('_', '/');
    const coinName = symbol.split('/')[0];
    ctx.editMessageText(`⚠️ **تأكيد إغلاق يدوي:**\nهل أنت متأكد من رغبتك في إغلاق صفقة **${coinName}** الآن؟`, 
        Markup.inlineKeyboard([
            [Markup.button.callback(`✅ نعم، إغلاق`, `DO_CLOSE_${ctx.match[1]}`)],
            [Markup.button.callback(`❌ تراجع`, `track_active`)]
        ])
    );
});

bot.action(/^DO_CLOSE_(.+)$/, async (ctx) => {
    const symbol = ctx.match[1].replace('_', '/');
    if (trades[symbol] && trades[symbol].isActive) {
        const t = await exchange.fetchTicker(symbol);
        closeTrade(symbol, ((t.last - trades[symbol].averagePrice) / trades[symbol].averagePrice) * 100, "يدوي", t.last);
        ctx.editMessageText(`✅ تم إغلاق ${symbol.split('/')[0]} بنجاح.`, getMenu());
    }
});

bot.action('market_status', async (ctx) => {
    await ctx.answerCbQuery();
    const tickers = await exchange.fetchTickers(['BTC/USDT', ...topGainers.slice(0, 20)]);
    const btc = tickers['BTC/USDT'];
    let msg = `🛰️ **نشرة أسعار السوق:**\n--------------------------\n🪙 Bitcoin: $${btc.last.toLocaleString()} (${btc.percentage >=0 ? '+':''}${btc.percentage.toFixed(2)}%)\n`;
    topGainers.slice(0, 20).forEach((s, i) => { 
        const c = tickers[s]; if(c) msg += `${i+1}. 🚀 ${s.split('/')[0]}: $${c.last.toFixed(8).replace(/\.?0+$/, '')} (${c.percentage >=0 ? '+':''}${c.percentage.toFixed(2)}%)\n`; 
    });
    ctx.editMessageText(msg, getMenu());
});

bot.action('get_wallet', async (ctx) => {
    await ctx.answerCbQuery();
    const ticker = await exchange.fetchTicker('BTC/USDT');
    let used = 0; 
    let coinsMsg = ""; 
    let count = 1;
    for (const s in trades) { 
        if (trades[s].isActive) { 
            used += trades[s].totalSpent; 
            coinsMsg += `${count}. 🪙 ${s.split('/')[0]}: ${trades[s].amount.toFixed(4)} ($${trades[s].totalSpent.toFixed(2)})\n`; 
            count++; 
        } 
    }
    wallet.total = (wallet.cash || 0) + (wallet.trading || 0) + used;
    let msg = `💳 **رصيد محفظة نادر (تراكمي):**\n--------------------------\n`;
    msg += `💵 الإجمالي: $${wallet.total.toFixed(4)}\n`;
    msg += `💰 كاش: $${(wallet.cash || 0).toFixed(4)}\n`;
    msg += `📈 للتداول: $${(wallet.trading + used).toFixed(4)}\n`;
    msg += `💸 المستخدم: $${used.toFixed(4)}\n`;
    msg += `📉 المتبقي: $${(wallet.trading).toFixed(4)}\n`;
    msg += `--------------------------\n`;
    msg += `🪙 بيتكوين: $${ticker.last.toLocaleString()}\n`;
    msg += `🚦 وضع السوق: ${ticker.percentage >= 0 ? '🟢 مستقر' : '🔴 متذبذب'}\n`;
    msg += `--------------------------\n`;
    msg += coinsMsg || "لا توجد عملات مفتوحة حالياً.";
    ctx.editMessageText(msg, getMenu());
});

bot.action('test_perf', (ctx) => { ctx.answerCbQuery(); ctx.editMessageText(`🧪 نظام V100 جاهز للعمل...`, getMenu()); });
bot.action('toggle_scan', (ctx) => { isScanning = !isScanning; save(); ctx.answerCbQuery(); ctx.editMessageText(isScanning ? "🚀 البوت يعمل الآن..." : "🛑 تم قفل البوت.", getMenu()); });
bot.action('force_close_confirm', (ctx) => ctx.editMessageText("⚠️ تأكيد الإغلاق الإجباري؟", Markup.inlineKeyboard([[Markup.button.callback("✅ نعم", "force_all"), Markup.button.callback("❌ لا", "main_menu")]])));
bot.action('force_all', async (ctx) => { 
    const active = Object.keys(trades).filter(s => trades[s].isActive);
    const tickers = await exchange.fetchTickers(active);
    for(let s of active) { 
        const coin = tickers[s]; 
        closeTrade(s, coin ? (((coin.last - trades[s].averagePrice) / trades[s].averagePrice) * 100) : 0, "تصفية", coin ? coin.last : 0); 
    }
    ctx.editMessageText("🚨 تم تصفية كل الصفقات.", getMenu());
});
bot.action('main_menu', (ctx) => { ctx.answerCbQuery(); ctx.editMessageText("🚀 لوحة تحكم نادر الرئيسية:", getMenu()); });

bot.start((ctx) => { lastChatId = ctx.chat.id; save(); ctx.reply("🚀 أهلاً يا نادر! تم التحديث بنجاح V100 online.", getMenu()); });
setInterval(coreEngine, 8000); 
bot.launch();
