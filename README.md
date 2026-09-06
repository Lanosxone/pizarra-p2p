# Pizarra P2P · USDT/PEN

Tablero de arbitraje P2P (Binance + Bybit + OKX) filtrado a Yape/Plin.
Los datos se traen del lado del servidor (función serverless) para que
nunca se muestre un nombre o monto inventado: si un exchange falla, esa
sección se marca como "no disponible" en vez de rellenarse con datos falsos.

## Estructura
- `index.html` — frontend (sin build, HTML/CSS/JS plano)
- `netlify/functions/p2p-data.js` — función que trae los datos reales
- `netlify.toml` — configuración de Netlify

## Desplegar
1. Sube estos 3 archivos/carpetas a tu repo de GitHub manteniendo la
   estructura de carpetas (`netlify/functions/p2p-data.js` debe quedar
   dentro de dos carpetas llamadas exactamente así).
2. En Netlify: **Add new site → Import an existing project → GitHub**
   → elige el repo.
3. Deja el build command vacío y el publish directory como `.` (Netlify
   lo toma solo del `netlify.toml`).
4. Deploy. Netlify detecta la función automáticamente.

## Notas
- Binance usa un endpoint público real y estable.
- Bybit y OKX no tienen una API pública documentada para esto (Bybit
  incluso exige firma/API key en su API oficial), así que se usa el
  endpoint que su propia web usa para visitantes anónimos. Si alguno
  deja de responder, revisa los logs de la función en el panel de
  Netlify (Functions → p2p-data) para ver el error exacto y ajustar.
- El costo de red entre exchanges (~1 USDT) es un estimado editable:
  busca la constante `NETWORK_FEE_USDT` en el `<script>` de `index.html`.
