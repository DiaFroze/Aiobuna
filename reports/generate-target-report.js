const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, ShadingType, BorderStyle,
  ExternalHyperlink, Footer, PageNumber
} = require('docx');

const outPath = path.join(__dirname, 'AI_OBUNA_target_analysis_2026-09-17.docx');

const colors = {
  navy: '17324D', blue: '2563EB', pale: 'EAF2FF', green: 'DCFCE7',
  amber: 'FEF3C7', red: 'FEE2E2', gray: '64748B', light: 'F8FAFC', white: 'FFFFFF'
};

const border = { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' };
const borders = { top: border, bottom: border, left: border, right: border };
const money = n => `$${n.toFixed(2)}`;
const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';

const videos = [
  {
    n: 1,
    name: 'D1-B / AI Reels 3 — AI subscriptions',
    url: 'https://www.instagram.com/p/Dcop5YWsVnv/',
    spend: 32.99, impressions: 16986, reach: 13602, clicks: 1231, lpv: 665,
    starts: 77, accepted: 52, sales: null, revenue: null,
    status: 'Лидер по подтверждённым пользователям',
    verdict: 'Лучший ролик по данным бота. У D1-B подтверждено 77 входов и 52 пользователя, дошедших до принятия условий. Цена такого пользователя — около $0,59. Часть Reels 3 пока не сопоставлена с продажами, поэтому итоговая эффективность может быть ещё выше.'
  },
  {
    n: 2,
    name: 'AI Reels 2 — Telegram bot',
    url: 'https://www.instagram.com/p/Dcn7v6pMXB-/',
    spend: 3.70, impressions: 3481, reach: 3357, clicks: 92, lpv: 78,
    starts: null, accepted: null, sales: null, revenue: null,
    status: 'Хорошая цена перехода, качество нужно подтвердить',
    verdict: 'Получил 78 загрузок страницы по $0,047. Результат Meta нормальный, но без данных админки нельзя назвать эти переходы покупателями.'
  },
  {
    n: 3,
    name: 'AI Reels 4 — Gemini + AI-курс',
    url: 'https://www.instagram.com/p/Dc_VwEas_EC/',
    spend: 1.97, impressions: 980, reach: 951, clicks: 63, lpv: 57,
    starts: null, accepted: null, sales: null, revenue: null,
    status: 'Самый дешёвый переход среди новых роликов',
    verdict: 'Стоимость загрузки страницы — $0,035. Это лучший показатель новых тестов, но выборка пока небольшая и продажи ещё не привязаны к источнику.'
  },
  {
    n: 4,
    name: 'D1-A / OLD — Gemini Pro',
    url: 'https://www.instagram.com/p/Dc_UkXzspV9/',
    spend: 42.51, impressions: 22914, reach: 19220, clicks: 2093, lpv: 871,
    starts: 6, accepted: 2, sales: null, revenue: null,
    status: 'Слабое качество пользователей',
    verdict: 'Кликов было много, но подтверждено только 6 входов и 2 пользователя, дошедших до условий. Цена такого пользователя — около $21,26. Этот ролик не стоит повторно запускать без нового оффера и отдельной проверки ссылки.'
  },
  {
    n: 5,
    name: 'AI Reels 1 — Gemini Pro',
    url: 'https://t.me/Aiobunabot?start=ad_meta_reels1',
    spend: 0.16, impressions: 277, reach: 264, clicks: 9, lpv: 7,
    starts: null, accepted: null, sales: null, revenue: null,
    status: 'Недостаточно данных',
    verdict: 'Расход всего $0,16 и 7 загрузок страницы. По такой выборке нельзя делать вывод о качестве. В отчёте указана отслеживаемая ссылка на бот; прямую Instagram-ссылку Meta в выгрузке не показала.'
  }
];

const legacy = [
  ['Instagram: Tg:aiobunabot', '$45,67', '1 127', '963', 'Нет отдельной метки продаж'],
  ['Instagram: Sizga kerakli deyarli…', '$8,08', '219', '193', 'Нет отдельной метки продаж'],
  ['Gemini Pro: посещения профиля — несколько запусков', '$56,68', '172 клика', '—', 'Цель была профиль, не бот'],
  ['New Traffic Ad Set', '$4,46', '4', '2', 'Слишком дорогой и слабый тест'],
  ['Технические/микро-тесты', '$2,01', '66', '59', 'Маленькая выборка']
];

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0, line: 276 },
    alignment: opts.align,
    children: [new TextRun({ text, bold: opts.bold, color: opts.color, size: opts.size ?? 21 })]
  });
}

function link(url, label) {
  return new Paragraph({
    spacing: { after: 160 },
    children: [
      new TextRun({ text: 'Ссылка: ', bold: true, size: 21 }),
      new ExternalHyperlink({
        link: url,
        children: [new TextRun({ text: label || url, style: 'Hyperlink', size: 21 })]
      })
    ]
  });
}

function cell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: options.fill ? { type: ShadingType.CLEAR, fill: options.fill } : undefined,
    borders,
    margins: { top: 100, bottom: 100, left: 100, right: 100 },
    children: [p(String(text), { bold: options.bold, color: options.color, size: options.size ?? 18, after: 0, align: options.align })]
  });
}

function metricTable(v) {
  const rows = [
    ['Расход', money(v.spend), 'Показы', v.impressions.toLocaleString('ru-RU')],
    ['Охват', v.reach.toLocaleString('ru-RU'), 'Клики по ссылке', v.clicks.toLocaleString('ru-RU')],
    ['Загрузки страницы', v.lpv.toLocaleString('ru-RU'), 'Цена загрузки', v.lpv ? money(v.spend / v.lpv) : '—'],
    ['Входы в бот', v.starts ?? 'Не определено', 'Приняли условия', v.accepted ?? 'Не определено'],
    ['Продажи', v.sales ?? 'Не определено', 'Выручка / прибыль', v.revenue ?? 'Не определено']
  ];
  return new Table({
    width: { size: 9360, type: WidthType.DXA }, columnWidths: [2100, 2580, 2100, 2580],
    rows: rows.map((r, i) => new TableRow({ children: [
      cell(r[0], 2100, { bold: true, fill: i % 2 ? colors.light : colors.pale }),
      cell(r[1], 2580, { fill: i % 2 ? colors.light : colors.pale }),
      cell(r[2], 2100, { bold: true, fill: i % 2 ? colors.light : colors.pale }),
      cell(r[3], 2580, { fill: i % 2 ? colors.light : colors.pale })
    ] }))
  });
}

const children = [];
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 800, after: 250 }, children: [new TextRun({ text: 'AI OBUNA', bold: true, color: colors.blue, size: 44 })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, children: [new TextRun({ text: 'Полный анализ таргетированной рекламы', bold: true, color: colors.navy, size: 34 })] }));
children.push(p('Отчёт по рекламным видео, расходам, переходам и качеству пользователей', { align: AlignmentType.CENTER, color: colors.gray, size: 23, after: 500 }));
children.push(p('Период данных Meta: 1 января — 16 сентября 2026 года', { align: AlignmentType.CENTER, bold: true, size: 20, after: 80 }));
children.push(p('Дата подготовки: 17 сентября 2026 года', { align: AlignmentType.CENTER, color: colors.gray, size: 19, after: 700 }));

children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Главный вывод')] }));
children.push(p('Лидером по подтверждённым пользователям стал D1-B / AI Reels 3. Он дал 77 входов в бот и 52 пользователя, дошедших до принятия условий. AI Reels 4 дал самый дешёвый переход, но его продажи пока не связаны с рекламной меткой. D1-A дал много кликов, но почти не привёл реальных пользователей — его повторный запуск не рекомендуется.'));
children.push(p('Всего Meta показывает $196,26 расходов, 5 013 кликов по ссылкам и 2 838 загрузок страниц. Эти цифры относятся ко всем 18 группам объявлений, включая старые, повторные, технические и отклонённые запуски. Фактически деньги списывались в 14 группах.', { bold: true, color: colors.navy }));

children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Сравнение основных видео')] }));
const summaryWidths = [2600, 1200, 1200, 1200, 1300, 1860];
const summaryRows = [
  ['Видео', 'Расход', 'Клики', 'Переходы', 'Пользователи', 'Оценка'],
  ...videos.map(v => [v.name, money(v.spend), v.clicks, v.lpv, v.starts ?? '—', v.status])
];
children.push(new Table({
  width: { size: 9360, type: WidthType.DXA }, columnWidths: summaryWidths,
  rows: summaryRows.map((r, i) => new TableRow({ children: r.map((x, j) => cell(x, summaryWidths[j], { bold: i === 0, fill: i === 0 ? colors.navy : (i % 2 ? colors.light : colors.white), color: i === 0 ? colors.white : undefined, size: 16 })) }))
}));
children.push(p('Важно: переходы и клики — не продажи. Там, где рекламная ссылка не была связана с заказом в базе, продажи и прибыль отмечены как «не определено».', { before: 180, color: 'B45309', bold: true }));

for (const v of videos) {
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(`${v.n}. ${v.name}`)] }));
  children.push(link(v.url));
  children.push(p(v.status, { bold: true, color: v.n === 1 ? '15803D' : v.n === 4 ? 'B91C1C' : colors.blue, size: 23 }));
  children.push(metricTable(v));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 100 }, children: [new TextRun('Анализ')] }));
  children.push(p(v.verdict));
  if (v.starts != null) {
    children.push(p(`Конверсия из клика во вход в бот: ${pct(v.starts, v.clicks)}. Конверсия из входа в принятие условий: ${pct(v.accepted, v.starts)}.`, { bold: true }));
  }
}

children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun('Старые и дополнительные запуски')] }));
children.push(p('Эти расходы входят в общий итог Meta, но старые кампании не позволяют надёжно определить продажи по отдельному видео.'));
const legacyWidths = [3000, 1200, 1200, 1200, 2760];
children.push(new Table({
  width: { size: 9360, type: WidthType.DXA }, columnWidths: legacyWidths,
  rows: [
    ['Запуск', 'Расход', 'Клики', 'Переходы', 'Комментарий'],
    ...legacy
  ].map((r, i) => new TableRow({ children: r.map((x, j) => cell(x, legacyWidths[j], { bold: i === 0, fill: i === 0 ? colors.navy : (i % 2 ? colors.light : colors.white), color: i === 0 ? colors.white : undefined, size: 16 })) }))
}));

children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Рекомендации на следующий запуск')] }));
const recommendations = [
  'Оставить D1-B / AI Reels 3 главным роликом и дать ему 60–70% дневного бюджета.',
  'AI Reels 4 протестировать ещё один полный день на $3–4: цена перехода лучшая, но данных по покупкам пока мало.',
  'AI Reels 2 оставить контрольным вариантом на $2–3 в день.',
  'D1-A не запускать повторно: клики дешёвые, но реальные пользователи слишком дорогие.',
  'Для каждого видео использовать отдельную ссылку вида ad_meta_reels1, ad_meta_reels2 и далее, а в отчёт админки добавить количество заказов, выручку и валовую прибыль по source.',
  'При бюджете $10 в день запускать одновременно два ролика, но не менять их чаще чем раз в сутки. Победителя выбирать по цене принятого пользователя и покупке, а не по кликам.'
];
children.push(...recommendations.map((t, i) => new Paragraph({
  numbering: { reference: 'steps', level: 0 }, spacing: { after: 120, line: 276 },
  children: [new TextRun({ text: t, size: 21 })]
})));

children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Что требуется для точного расчёта прибыли')] }));
children.push(p('Текущий отчёт бота фиксирует источник входа, но не показывает готовую связку «реклама → заказ → себестоимость → прибыль». Поэтому точное число продаж и прибыль по старым роликам восстановить нельзя без дополнительной выборки из рабочей базы. В следующих запусках такая связка должна сохраняться автоматически.'));
children.push(p('Формула для контроля: прибыль по ролику = выручка оплаченных заказов − себестоимость товара − рекламные расходы. Главный показатель для решений — прибыль на $1 рекламы, дополнительно контролируются цена покупателя и доля повторных покупок.', { bold: true, color: colors.navy }));

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Aptos', size: 21, color: '1F2937' }, paragraph: { spacing: { after: 120, line: 276 } } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Aptos Display', size: 30, bold: true, color: colors.navy }, paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Aptos Display', size: 24, bold: true, color: colors.blue }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } }
    ]
  },
  numbering: { config: [{ reference: 'steps', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 520, hanging: 280 } } } }] }] },
  sections: [{
    properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'AI OBUNA • Анализ рекламы • ', color: colors.gray, size: 17 }), new TextRun({ children: [PageNumber.CURRENT], color: colors.gray, size: 17 })] })] }) },
    children
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer);
  console.log(outPath);
});
