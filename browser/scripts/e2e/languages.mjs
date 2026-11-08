// What each language of the popup and dashboard shows, spot-checked, for the
// Chromium and Firefox checks (verify-languages*.mjs).

export const EXPECTED = {
  ar: {
    footer: "غير متصل بـ Parousia Desktop",
    settings: ["عام", "المظهر", "الخصوصية"],
    nav: ["نظرة عامة", "الأنشطة", "النشاط الافتراضي", "الإعدادات"],
    summary: /1–\d+/,
  },
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
  nl: {
    footer: "Niet verbonden met Parousia Desktop",
    settings: ["Algemeen", "Weergave", "Privacy"],
    nav: ["Overzicht", "Activiteiten", "Standaardactiviteit", "Instellingen"],
    summary: /^1–\d+ van /,
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
  el: {
    footer: "Χωρίς σύνδεση στο Parousia Desktop",
    settings: ["Γενικά", "Εμφάνιση", "Απόρρητο"],
    nav: ["Επισκόπηση", "Δραστηριότητες", "Προεπιλεγμένη δραστηριότητα", "Ρυθμίσεις"],
    summary: /^1–\d+ από /,
  },
  es: {
    footer: "Sin conexión con Parousia Desktop",
    settings: ["General", "Apariencia", "Privacidad"],
    nav: ["Resumen", "Actividades", "Actividad predeterminada", "Ajustes"],
    summary: /^1–\d+ de /,
  },
  "es-419": {
    footer: "Sin conexión con Parousia Desktop",
    settings: ["General", "Apariencia", "Privacidad"],
    nav: ["Resumen", "Actividades", "Actividad predeterminada", "Configuración"],
    summary: /^1–\d+ de /,
  },
  ko: {
    footer: "Parousia Desktop에 연결 안 됨",
    settings: ["일반", "모양", "개인정보"],
    nav: ["개요", "액티비티", "기본 액티비티", "설정"],
    summary: /1–\d+$/,
  },
  "pt-BR": {
    footer: "Não conectado à Parousia Desktop",
    settings: ["Geral", "Aparência", "Privacidade"],
    nav: ["Visão geral", "Atividades", "Atividade padrão", "Configurações"],
    summary: /^1–\d+ de /,
  },
  "pt-PT": {
    footer: "Sem ligação à Parousia Desktop",
    settings: ["Geral", "Aspeto", "Privacidade"],
    nav: ["Vista geral", "Atividades", "Atividade predefinida", "Definições"],
    summary: /^1–\d+ de /,
  },
};
