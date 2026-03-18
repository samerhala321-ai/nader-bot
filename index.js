const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');

// التوكن الخاص ببوتك (لا تشاركه مع أحد)
const BOT_TOKEN = '8685761250:AAFXT9Kn6afYbs2hd_F3EJ-O8PvCSl1sWBI';
const bot = new Telegraf(BOT_TOKEN);
const binance = new ccxt.binance();

let alertPrice = null;
let chatId = null;

console.log("🚀 بوت نادر السحابي يعمل الآن...");

// 1. ميزة القائمة السريعة: اكتب "قائمة"
bot.hears('قائمة', async (ctx) => {
    try {
        const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
        let message = "📊 أسعار العملات الآن يا نادر:\n\n";
        for (const s of symbols) {
            const t = await binance.fetchTicker(s);
            message += `🔹 ${s.split('/')[0]}: ${t.last}$\n`;
        }
        ctx.reply(message);
    } catch (e) {
        ctx.reply("❌ عذراً، فشل جلب القائمة.");
    }
});

// 2. ميزة التنبيه الذكي: اكتب "تنبيه 65000"
bot.hears(/^تنبيه\s+(\d+)$/i, (ctx) => {
    alertPrice = parseFloat(ctx.match[1]);
    chatId = ctx.chat.id;
    ctx.reply(`✅ تم ضبط التنبيه يا نادر! سأخبرك فوراً عندما يصل البيتكوين لـ ${alertPrice}$`);
});

// 3. ميزة السعر الفردي: اكتب "سعر btc"
bot.hears(/^(سعر|price)\s+(.+)$/i, async (ctx) => {
    const coin = ctx.match[2].toUpperCase();
    try {
        const ticker = await binance.fetchTicker(coin + '/USDT');
        ctx.reply(`💰 سعر ${coin} الآن:\n${ticker.last} دولار`);
    } catch (e) {
        ctx.reply('❌ تأكد من اسم العملة (مثال: سعر btc)');
    }
});

// وظيفة المراقبة التلقائية في الخلفية (كل 30 ثانية)
setInterval(async () => {
    if (alertPrice && chatId) {
        try {
            const ticker = await binance.fetchTicker('BTC/USDT');
            const currentPrice = ticker.last;
            
            // تنبيه لو السعر وصل للهدف أو نزل عنه
            if (currentPrice <= alertPrice) {
                bot.telegram.sendMessage(chatId, `🚨 عاجل يا نادر! البيتكوين وصل لـ ${currentPrice}$ (هدف التنبيه: ${alertPrice}$)`);
                alertPrice = null; // إيقاف التنبيه بعد إرساله
            }
        } catch (e) {
            console.log("خطأ في المراقبة");
        }
    }
}, 30000); 

bot.launch().then(() => console.log("✅ البوت متصل ومستعد للعمل!"));

// لإبقاء السيرفر حياً في البيئات السحابية
const http = require('http');
http.createServer((req, res) => {
  res.write("Bot is running");
  res.end();
}).listen(8080);
