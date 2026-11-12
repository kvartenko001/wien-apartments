// Публичные ключи. Оба предназначены для кода в браузере:
// - Supabase publishable: без входа данные не отдаёт (RLS + белый список участников)
// - Mapbox: перед публикацией заменить на токен с ограничением по адресу сайта
window.APP_CONFIG = {
  SUPABASE_URL: "https://nyxvpcrftzsoprhnethq.supabase.co",
  SUPABASE_KEY: "sb_publishable_lXwgcxmQKIw4XFveOEfOcg_n8r2WBzh",
  MAPBOX_TOKEN: ""  // вставляется ключ с ограничением по адресу сайта,
  BUDGET_DEFAULT: 1500
};
