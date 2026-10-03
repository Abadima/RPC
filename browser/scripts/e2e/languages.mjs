// What each language of the popup and dashboard shows, spot-checked, for the
// Chromium and Firefox checks (verify-languages*.mjs).

/** What each language shows, spot-checked: the popup's own HTML, the code's text, and the dashboard. */
export const EXPECTED = {
  de: {
    footer: "Nicht mit Parousia Desktop verbunden",
    settings: ["Allgemein", "Darstellung", "Datenschutz"],
    nav: ["Übersicht", "Aktivitäten", "Standardaktivität", "Einstellungen"],
    summary: /^1–\d+ von /,
  },
  fr: {
    footer: "Non connecté à Parousia Desktop",
    settings: ["Général", "Apparence", "Confidentialité"],
    nav: ["Aperçu", "Activités", "Activité par défaut", "Paramètres"],
    summary: /^1–\d+ sur /,
  },
  ja: {
    footer: "Parousia Desktop に未接続",
    settings: ["一般", "外観", "プライバシー"],
    nav: ["概要", "アクティビティ", "デフォルトのアクティビティ", "設定"],
    summary: /^\S+ 件中 1–\d+ 件$/,
  },
  ro: {
    footer: "Neconectat la Parousia Desktop",
    settings: ["General", "Aspect", "Confidențialitate"],
    nav: ["Prezentare generală", "Activități", "Activitate implicită", "Setări"],
    summary: /^1–\d+ din /,
  },
  ru: {
    footer: "Нет подключения к Parousia Desktop",
    settings: ["Общие", "Оформление", "Конфиденциальность"],
    nav: ["Обзор", "Активности", "Активность по умолчанию", "Настройки"],
    summary: /^1–\d+ из /,
  },
  sv: {
    footer: "Inte ansluten till Parousia Desktop",
    settings: ["Allmänt", "Utseende", "Integritet"],
    nav: ["Översikt", "Aktiviteter", "Standardaktivitet", "Inställningar"],
    summary: /^1–\d+ av /,
  },
  zh: {
    footer: "未连接到 Parousia Desktop",
    settings: ["常规", "外观", "隐私"],
    nav: ["概览", "活动", "默认活动", "设置"],
    summary: /^第 1–\d+ 项，共 /,
  },
  en: {
    footer: "Not connected to Parousia Desktop",
    settings: ["General", "Appearance", "Privacy"],
    nav: ["Overview", "Activities", "Default Activity", "Settings"],
    summary: /^1–\d+ of /,
  },
};
