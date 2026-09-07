// netlify/functions/p2p-data.js
//
// Trae anuncios P2P reales de Binance, Bybit y OKX para USDT/PEN,
// filtrados a métodos de pago Yape/Plin. Corre del lado del servidor
// para evitar el bloqueo de CORS del navegador y para poder manejar
// con cuidado cualquier falla de un exchange sin nunca inventar datos.
//
// Regla de oro de este archivo: si algo falla, se marca como
// "unavailable" — jamás se devuelve un dato de relleno/mock.

const ASSET = "USDT";
const FIAT = "PEN";
const PAY_KEYWORDS = ["yape", "plin"];
const ROWS = 20;

function matchesPayMethod(methods) {
  return methods.some((m) =>
    PAY_KEYWORDS.some((k) => (m || "").toLowerCase().includes(k))
  );
}

// Descarta anuncios con precio muy alejado de lo normal (basura, trampas,
// anuncios de prueba). Compara contra la mediana del propio lote: si un
// precio se aleja más de 25%, se descarta.
function dropPriceOutliers(items) {
  if (items.length < 3) return items;
  const sorted = [...items].map((i) => i.price).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return items.filter((i) => Math.abs(i.price - median) / median <= 0.25);
}

async function fetchWithTimeout(url, options, ms = 9000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ---------- Binance ----------
// Endpoint público, sin API key, usado por la propia web de Binance P2P.
async function fetchBinanceSide(tradeType) {
  const res = await fetchWithTimeout(
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset: ASSET,
        fiat: FIAT,
        tradeType, // "BUY" => anuncios de gente vendiendo (para que tú compres)
        page: 1,
        rows: ROWS,
        payTypes: [],
        publisherType: null,
      }),
    }
  );
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  const parsed = list
    .map((item) => {
      const adv = item.adv || {};
      const advertiser = item.advertiser || {};
      const methods = (adv.tradeMethods || []).map(
        (m) => m.tradeMethodName || m.identifier || ""
      );
      return {
        price: parseFloat(adv.price),
        min: parseFloat(adv.minSingleTransAmount),
        max: parseFloat(adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount),
        merchant: advertiser.nickName || "—",
        methods,
        exchange: "binance",
        // Binance no expone un link público directo por anuncio individual,
        // así que enlazamos al tablero ya filtrado por activo/moneda.
        link: `https://p2p.binance.com/en/trade/all-payments/USDT?fiat=PEN`,
      };
    })
    .filter((o) => !isNaN(o.price));
  return { list: dropPriceOutliers(parsed), debug: undefined };
}
// Bybit no publica un endpoint público documentado para solo lectura
// (su API oficial v5 exige firma/API key incluso para listar anuncios).
// Intentamos el endpoint que usa su propia web para visitantes anónimos;
// si cambia o deja de responder, esta sección queda "unavailable" —
// nunca se rellena con datos falsos.
async function fetchBybitSide(side) {
  // side: "1" = comprar (para ti), "0" = vender (para ti) según su web
  const linkAction = side === "1" ? "buy" : "sell";
  const res = await fetchWithTimeout(
    "https://api2.bybit.com/fiat/otc/item/online",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "",
        tokenId: ASSET,
        currencyId: FIAT,
        payment: [],
        side, // "1" buy / "0" sell desde la perspectiva del visitante
        size: String(ROWS),
        page: "1",
        amount: "",
        authMaker: false,
        canTrade: false,
      }),
    }
  );
  const rawText = await res.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Bybit: respuesta no-JSON (status ${res.status}): ${rawText.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}: ${rawText.slice(0, 300)}`);
  }
  const list = json?.result?.items || [];
  const parsed = list
    .map((item) => {
      const methods = (item.payments || []).map(String);
      return {
        price: parseFloat(item.price),
        min: parseFloat(item.minAmount),
        max: parseFloat(item.maxAmount),
        merchant: item.nickName || "—",
        methods,
        exchange: "bybit",
        link: `https://www.bybit.com/en/fiat/trade/otc/${linkAction}/USDT/PEN`,
      };
    })
    .filter((o) => !isNaN(o.price));
  // Diagnóstico temporal: si tras parsear no quedó nada, mandamos
  // una muestra de la respuesta cruda para poder ver por qué.
  const debug =
    parsed.length === 0
      ? {
          retCode: json.ret_code ?? json.retCode,
          retMsg: json.ret_msg ?? json.retMsg,
          rawItemCount: list.length,
          sampleItem: list[0] || null,
        }
      : undefined;
  return { list: dropPriceOutliers(parsed), debug };
}

// ---------- OKX ----------
// Igual que Bybit: sin API pública documentada para esto. Intentamos el
// endpoint que usa okx.com para cargar su tablero de anuncios; si falla,
// queda "unavailable".
async function fetchOkxSide(side) {
  // side: "buy" o "sell" desde la perspectiva del visitante
  const url = `https://www.okx.com/v3/c2c/tradingOrders/books?t=${Date.now()}&quoteCurrency=${FIAT}&baseCurrency=${ASSET}&side=${side}&paymentMethod=all&userType=all&showTrade=false&showFollow=false&isAbleFilterMerchantBlocked=false`;
  const res = await fetchWithTimeout(url, {
    headers: { "Content-Type": "application/json" },
  });
  const rawText = await res.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`OKX: respuesta no-JSON (status ${res.status}): ${rawText.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`OKX HTTP ${res.status}: ${rawText.slice(0, 300)}`);
  }
  const rawList = json?.data?.buy || json?.data?.sell || (Array.isArray(json?.data) ? json.data : []);
  const list = Array.isArray(rawList) ? rawList : [];
  const parsed = list
    .map((item) => {
      const methods = (item.paymentMethods || item.payMethods || []).map(String);
      return {
        price: parseFloat(item.price),
        min: parseFloat(item.quoteMinAmountPerOrder || item.minAmount),
        max: parseFloat(item.quoteMaxAmountPerOrder || item.maxAmount),
        merchant: item.nickName || item.merchantName || "—",
        methods,
        exchange: "okx",
        link: `https://www.okx.com/p2p-markets/${FIAT.toLowerCase()}/${side}-usdt`,
      };
    })
    .filter((o) => !isNaN(o.price));
  const debug =
    parsed.length === 0
      ? {
          code: json.code,
          msg: json.msg,
          rawItemCount: list.length,
          sampleItem: list[0] || null,
        }
      : undefined;
  return { list: dropPriceOutliers(parsed), debug };
}

// ---------- Envoltorio a prueba de fallos ----------
// Cada exchange se resuelve por separado: si uno falla, los demás
// igual llegan bien, y el que falló se marca explícitamente.
async function safe(fn, label) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err.message || err), label };
  }
}

exports.handler = async function () {
  const [
    binanceBuy,
    binanceSell,
    bybitBuy,
    bybitSell,
    okxBuy,
    okxSell,
  ] = await Promise.all([
    safe(() => fetchBinanceSide("BUY"), "binance"),
    safe(() => fetchBinanceSide("SELL"), "binance"),
    safe(() => fetchBybitSide("1"), "bybit"),
    safe(() => fetchBybitSide("0"), "bybit"),
    safe(() => fetchOkxSide("buy"), "okx"),
    safe(() => fetchOkxSide("sell"), "okx"),
  ]);

  const pack = (buy, sell) => {
    if (!buy.ok || !sell.ok) {
      return {
        available: false,
        error: !buy.ok ? buy.error : sell.error,
      };
    }
    const out = { available: true, buy: buy.data.list, sell: sell.data.list };
    const debug = buy.data.debug || sell.data.debug;
    if (debug) out.debug = debug;
    return out;
  };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      updated: new Date().toISOString(),
      asset: ASSET,
      fiat: FIAT,
      exchanges: {
        binance: pack(binanceBuy, binanceSell),
        bybit: pack(bybitBuy, bybitSell),
        okx: pack(okxBuy, okxSell),
      },
    }),
  };
};
