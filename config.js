// Публичные ключи. Оба предназначены для кода в браузере:
// - Supabase publishable: без входа данные не отдаёт (RLS + белый список участников)
// - Mapbox: токен «Wien Apartments», работает только на kvartenko001.github.io/wien-apartments/
window.APP_CONFIG = {
  SUPABASE_URL: "https://nyxvpcrftzsoprhnethq.supabase.co",
  SUPABASE_KEY: "sb_publishable_lXwgcxmQKIw4XFveOEfOcg_n8r2WBzh",
  MAPBOX_TOKEN: "pk.eyJ1IjoicGxhdGluaSIsImEiOiJjbXdlMmc4cjcwY2pnMnhzMTh1eHdrdDgwIn0.p9Z2yYNpX0MtWcljc683-w",
  BUDGET_DEFAULT: 1500
};
