// Thoi tiet tu API THAT, toi cap PHUONG/khu vuc (khong chi cap thanh pho):
// - Toa do: OpenStreetMap Nominatim (tra duoc phuong/xa sau sap nhap 7/2025).
//   Ten cu (vd "Quan 9") -> LLM quy ra phuong moi + toa do gan dung truoc khi tra.
// - So lieu: Open-Meteo theo DUNG toa do do: hien tai + tung 15 phut 2 gio toi +
//   tung gio 6 gio toi (+ theo ngay neu hoi may ngay toi).
// Luu y trung thuc: Open-Meteo la MO HINH du bao (luoi vai km), khong phai radar.
const WMO = {
  0: "trời quang", 1: "ít mây", 2: "có mây", 3: "nhiều mây",
  45: "sương mù", 48: "sương mù đóng băng",
  51: "mưa phùn nhẹ", 53: "mưa phùn", 55: "mưa phùn dày",
  61: "mưa nhẹ", 63: "mưa", 65: "mưa to",
  66: "mưa lạnh", 67: "mưa lạnh nặng",
  71: "tuyết nhẹ", 73: "tuyết", 75: "tuyết dày", 77: "hạt tuyết",
  80: "mưa rào nhẹ", 81: "mưa rào", 82: "mưa rào dữ dội",
  85: "mưa tuyết nhẹ", 86: "mưa tuyết dày",
  95: "dông", 96: "dông kèm mưa đá nhẹ", 99: "dông kèm mưa đá to",
};
const UA = "L1-assistant-bot/1.0 (weather lookup for internal Zalo group)";
const geoCache = new Map();
const ADMIN_TYPES = new Set(["suburb", "quarter", "city_district", "district", "town", "village", "city", "municipality", "county", "state", "province", "neighbourhood", "hamlet"]);

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=vn&accept-language=vi&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const list = await res.json();
  // Uu tien ket qua la don vi hanh chinh (phuong/xa/thanh pho), khong phai ten duong/cong vien.
  return list.find((r) => ADMIN_TYPES.has(r.addresstype)) || null;
}

// place: { query, label, lat, lon } do LLM rut ra tu cau hoi.
export async function geocode(place) {
  const key = `${place.query}|${place.lat}|${place.lon}`;
  if (geoCache.has(key)) return geoCache.get(key);
  let out = null;
  try {
    const r = place.query ? await nominatim(place.query) : null;
    if (r) out = { lat: +r.lat, lon: +r.lon, name: r.display_name.split(",").slice(0, 2).join(",").trim(), by: "osm" };
  } catch {
    /* thu cach khac */
  }
  if (!out && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    out = { lat: place.lat, lon: place.lon, name: place.label || place.query, by: "llm" };
  }
  if (out) geoCache.set(key, out);
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
// "2026-09-25" -> "T6 25/09" (tinh tu chuoi ngay, KHONG qua gio he thong -> khong lech ngay).
function dayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${pad(d)}/${pad(m)}`;
}
const hhmm = (iso) => iso.slice(11, 16);

// Tra ve du lieu da gon (de LLM tra loi dung cau hoi), hoac null neu loi.
export async function getWeatherAt({ lat, lon }, { days = 0 } = {}) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,precipitation,rain,showers,weather_code,cloud_cover` +
    `&minutely_15=precipitation&forecast_minutely_15=8` +
    `&hourly=precipitation_probability,precipitation,weather_code&forecast_hours=6` +
    (days > 0 ? `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=${Math.min(days + 1, 7)}` : "") +
    `&timezone=Asia%2FHo_Chi_Minh`;
  const wx = await fetch(url, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  if (!wx?.current) return null;
  const c = wx.current;
  const data = {
    luc: `${hhmm(c.time)} ${dayLabel(c.time.slice(0, 10))}`,
    hien_tai: {
      troi: WMO[c.weather_code] || "?",
      nhiet_do_C: Math.round(c.temperature_2m),
      do_am_pct: c.relative_humidity_2m,
      may_pct: c.cloud_cover,
      mua_mm_15ph: c.precipitation,
    },
    mua_tung_15_phut_2h_toi: (wx.minutely_15?.time || []).map((t, i) => `${hhmm(t)}: ${wx.minutely_15.precipitation[i]}mm`),
    tung_gio_6h_toi: (wx.hourly?.time || []).map(
      (t, i) => `${hhmm(t)}: ${WMO[wx.hourly.weather_code[i]] || "?"}, mưa ${wx.hourly.precipitation[i]}mm, khả năng ${wx.hourly.precipitation_probability[i]}%`
    ),
  };
  if (wx.daily?.time) {
    data.theo_ngay = wx.daily.time.map(
      (t, i) =>
        `${dayLabel(t)}: ${WMO[wx.daily.weather_code[i]] || "?"}, ${Math.round(wx.daily.temperature_2m_min[i])}-${Math.round(wx.daily.temperature_2m_max[i])}°C, khả năng mưa ${wx.daily.precipitation_probability_max[i]}%`
    );
  }
  return data;
}
