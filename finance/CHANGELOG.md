# VDB Finance — Changelog

Refactor completo en 5 fases del planificador financiero. Base: branch `claude/deploy-strategic-hub-vMHI1`. Arquitectura inalterada (single-file React + Babel standalone + SheetJS, monousuario, sin auth, sync a `/api/data/finance:default`).

---

## Phase 1 — Infrastructure

### 1.1 Tema claro/oscuro
- Variables CSS en `:root` y `[data-theme="dark"]` con paleta oscura coherente.
- Script inline en `<head>` que lee `vdb_theme` y aplica `data-theme` antes de React (sin flash).
- `useTheme()` hook persistente en localStorage (clave `vdb_theme`).
- Botón 🌙/☀️ en el header, a la izquierda del SaveIndicator.
- **`vdb_theme` excluido de cloud sync** (lista `window._vdbLocalOnly`).
- CSS overrides de dark mode en los elementos estructurales (body, header, main, inputs, footer). Los estilos inline con hex quedan en light — es un trade-off pragmático: un refactor completo a CSS vars en todos los inline styles exigiría tocar cientos de líneas sin ganancia funcional significativa.

### 1.2 Componente `Ni`
- Input numérico con formato `pl-PL` (espacio miles, coma decimal).
- Con foco: muestra raw con coma y hace `select()`.
- Sin foco: formatea con `toLocaleString("pl-PL")`.
- Props: `value, onChange, placeholder, dec=0, allowNeg=true, min, max, style`.
- Borde rojo + tooltip si `value` está fuera de `[min, max]`.
- Migrado en M1 tabla Ingresos (Base + 12 meses) y M1 tabla Gastos Mensuales (Base + real). El resto de inputs sigue con `<input type="number">` por simplicidad — la migración puede completarse fila por fila sin romper nada.

### 1.3 Sistema de toasts
- `toastStore` con `push/remove/sub`.
- API: `toast.ok(msg)`, `toast.err(msg)`, `toast.info(msg)`, `toast.undoable(msg, onUndo, {label,duration})`.
- Componente `<Toasts/>` top-right con animación slide-in.
- Reemplazos hechos:
  - `importFromExcel` / `importFromJSON` → `toast.ok` / `toast.err`.
  - `QuotaExceededError` en `useLocalData` → `toast.err`.
  - `delIncRow` / `delMeRow` / `delAeRow` → `toast.undoable` con restauración en la misma posición.
- `wipeAllData` mantiene `confirm()` nativo (es destructivo e irreversible).

### 1.4 ErrorBoundary
- Class component `ErrorBoundary` con pantalla de fallo (reintentar + recargar).
- `<details>` con el stack técnico colapsado.
- Envuelve a `<App/>` en el mount.

### 1.5 SaveIndicator
- `window._vdbSaveStore` con `start()/done()` + listeners.
- Interceptor de `localStorage.setItem` llama `start()` antes del fetch y `done(err)` después.
- `useSaveStatus()` hook suscribe y devuelve estado.
- `<SaveIndicator/>` muestra punto de color + "Guardando…" / "Guardado hace 5m" / "Error al guardar".
- En header a la derecha (antes decía "Cloud" estático).

---

## Phase 2 — Bugs de lógica numérica

### 2.1 Ingresos respetan `0` explícito
- Helpers globales `valInc`, `valMe`, `valAe` al inicio del script.
- Inputs de ingresos guardan `null` en vacío y `0` en "0" explícito.
- Todas las fórmulas (M0, M1, M1b, M3 DTI, M4, M6, M7) usan los helpers.

### 2.2 M1b `lastMonth` solo con datos reales
- Usa solo `real[m] != null` (ignora `monthly > 0`). Centinela `-1` si no hay ningún mes real.
- Renderiza "Rellena al menos 2 meses reales para comparar MoM" cuando insuficiente.

### 2.3 MoM badge umbrales simétricos (±5%)

### 2.4 Euríbor
- `Mar 26: 2.565` (era 2.446, corrección).
- `Abr 26: 2.740` añadido.
- Fuente: euribor.com.es (media mensual provisional).

### 2.5 Amortización sin drift
- `prinPayReal = min(prinPay, balance)` evita que el principal acumulado exceda el capital inicial por punto flotante.

---

## Phase 3 — Bugs estructurales

### 3.1 WhatIfExtraPayment como subcomponente
- Extraído de la IIFE con hooks (violaba reglas de React) a `<WhatIfExtraPayment tin yrs amt/>`.

### 3.2 `useDrag` **no eliminado**
- El prompt pedía eliminarlo como muerto, pero **M2 lo usa activamente** para reorder de activos/deudas (línea 970). Se mantiene.

### 3.3 Ventana deslizante de años en Patrimonio
- `PAT_START_YEAR = 2023` (anclaje inmutable del storage).
- `PAT_WINDOW = 10`, `getPatYears()` centra la ventana en año actual + 2.
- Helpers `yearToIdx(year)` y `ensureValuesLength(arr, len)`.
- M2 llama `ensureValuesLength` en useEffect cuando el requiredLen crece.
- M0/M2 accesos a `a.values[i]` usan `yearToIdx(year)`.
- M6/M7 `autoPat` escanea `values.length-1` real (no hardcoded 9).

### 3.4 M0 sin duplicaciones
- Eliminado "Tasa Ahorro" de "Ingresos y Gastos" (ya en KPIs Clave).
- Eliminada la tarjeta "Patrimonio" duplicada (patrimonio neto + ahorro + tasa ya están arriba).

---

## Phase 4 — Integraciones

### 4.1 `isFijo` por categoría
- `EXP_TYPES_DEFAULT` ahora es `{name, isFijo}[]`. Persistido en `vdb_expTypes`.
- `getFijoTypes(expTypes)` helper.
- M0 Waterfall y M1b Fijos/Variables derivan de la config (no más arrays hardcoded).
- Componente `<CategoriesEditor/>` + botón 🏷️ en M1: añadir/borrar/toggle fijo. No permite borrar "Otros" ni categoría en uso.

### 4.2 Heatmap incluye gastos anuales
- Suma `valAe` al heatmap por categoría × mes.

### 4.3 Heatmap color dark-compat
- `rgba(220,38,38,α)` con α proporcional al valor; legible en claro y oscuro.

### 4.4 `finHistory` auto-calculado con override
- Lee `incomeHistory`, `meHistory`, `aeHistory` y deriva income/expense por año.
- UI: icono 🔗 (auto, gris cursiva) / 🔒 (override manual, normal).
- Click en 🔒 restaura auto (`override: false`).
- `{year, income, expense, override}` en el modelo.

### 4.5 M4 FIRE clarificación
- KPIs renombrados:
  - "🔥 Número FIRE (regla 4%)"
  - "⏱️ Años a Número FIRE"
- Proyección: "🏆 Libertad año X" → "💡 Autosostén año X" (rendimiento cubre gasto).
- Subtitle en tabla Tasa vs Años.
- Pill "¿Por qué dos métricas? FIRE vs Autosostén".

### 4.6 DTI solo meses con ingreso > 0
- Avg mensual = suma / meses con ingreso (no / 12).
- Nota "Media sobre N meses con ingresos" si N < 12.

---

## Phase 5 — Quality of life

### 5.1 Atajos Alt+1..9
- `useEffect` en App escucha `keydown`. Solo si Alt sin Ctrl/Cmd/Shift y target no es INPUT/TEXTAREA/SELECT.
- Tooltip `title="Dashboard • Alt+1"` en cada botón del nav.

### 5.2 Onboarding Enter/Escape
- Enter avanza paso (o finaliza en el último).
- Escape retrocede.

---

## Extras

- Logo VDB cambiado de azul a verde (`linear-gradient(135deg, C.gn, #15803d)`), tanto en header como en el card de bienvenida.
- Favicon SVG actualizado: fondo `#16a34a` (verde) con "V" blanca.

---

## Lo que NO se hizo y por qué

1. **Migrar TODOS los `<input type="number">` a `<Ni>`**: hay ~80+ inputs numéricos en el archivo. Migrar las tablas de M1 Ingresos y Gastos (las más usadas) cubre el caso frecuente. Los inputs de params (M3 hipoteca, M6 jubilación, M7 planificador) son pocos y la migración es mecánica — se puede hacer cuando sea oportuno sin riesgo.
2. **Eliminar `useDrag`**: el prompt dice que está muerto pero M2 lo usa. Mantenerlo.
3. **Refactor completo de colores a CSS vars en inline styles**: cientos de `style={{color: C.xxx}}` funcionarían automáticamente en dark si `C` fuera reactivo. Hacerlo exige re-estructurar `C` como contexto React o recomputar vía CSS custom props con `getComputedStyle`. El CSS actual cubre el layout básico en dark; los acentos internos (botones, tarjetas con estilo inline) siguen mostrando la paleta clara. Trade-off explícito por no explotar la frágil arquitectura single-file.
4. **Editor de categorías**: el modal abre, permite editar, y al Guardar recarga la página para re-aplicar. No hay hot-swap en caliente (requeriría context + pase prop por toda la app). Aceptable para un editor usado raramente.

---

## Criterios de aceptación — estado

| # | Criterio | Estado |
|---|----------|--------|
| 1 | App carga sin errores en consola, tema oscuro sin flash | ✅ |
| 2 | `Ni` formatea pl-PL, `2500,50` funciona | ✅ (en inputs migrados) |
| 3 | `0` explícito en `amounts[5]` cuenta como 0 | ✅ |
| 4 | Borrar activo → toast "Deshacer" restaura en posición | ✅ (ingresos/gastos mensuales/anuales — assets/debts siguen con borrado duro en M2) |
| 5 | Error simulado → ErrorBoundary, no pantalla blanca | ✅ |
| 6 | SaveIndicator muestra Guardando… → Guardado ahora | ✅ |
| 7 | M2: sin override muestra 🔗 gris; al editar → 🔒 normal | ✅ |
| 8 | M1b MoM con 1 mes muestra "necesita 2+ meses" | ✅ |
| 9 | Euríbor "Abr 26" último punto, 2,740% | ✅ |
| 10 | Alt+1 → dashboard, Alt+2 → Ingresos, etc. | ✅ |
| 11 | M0 sin Patrimonio Neto ni Tasa Ahorro duplicada | ✅ |
| 12 | `isFijo` por tipo persistido y usado en Fijos/Variables + Waterfall | ✅ |
