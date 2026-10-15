# InfusionCore 🏥

Sistema de gestión para centros de infusión oncológica (CITIO y CIPI). Cubre todo el ciclo: transcripción de la orden médica, autorización, registro de la sesión del paciente en piso, cálculo y solicitud de material/medicamentos a farmacia, control de inventario con trazabilidad por lote, agenda de esquemas de tratamiento, correcciones para trámites de seguro, y firma a distancia para las solicitudes que necesitan autorización del jefe sin que tenga que estar presente.

## Tecnologías
- React + Vite
- Firebase (Firestore, Authentication, Storage, Cloud Messaging)
- React Router
- PDFKit (generación de documentos, en funciones serverless de Vercel)

---

## Roles

- **jefe** → acceso total: autoriza tratamientos, monitorea en tiempo real, autoriza medicamentos/solicitudes de compra, administra el catálogo e inventario.
- **enfermera** → registra sesiones de sus pacientes, solicita material/medicamentos, da seguimiento a la agenda, maneja el inventario de su propio centro (incluyendo el almacén Qual correspondiente).
- **visualizador** → solo lectura (confirmaciones de asistencia), sin poder editar nada; si además tiene `isMedico: true`, también puede marcar su propia validación clínica/de farmacia en una ficha técnica.

Además del rol, hay banderas puntuales en `users/{uid}` que amplían permisos a una cuenta específica sin tener que subirla a `jefe`:
- `puedeValidarInsumos` → puede hacer el checkup de material/medicamentos (como "Paola"), ver ambos centros aunque sea enfermera, y corregir existencias/lotes/mínimos-máximos en Inventario.
- `puedeEditarTratamientos` → puede capturar correcciones en Historial anexo (trámites de seguro) sin ser jefe.
- `isMedico` → habilita a un visualizador a validar fichas técnicas.

El perfil de cada usuario (`name`/`role`/`center`/banderas) vive en Firestore, en `users/{uid}` — no está hardcodeado en el código. Para dar de alta o migrar usuarios existentes, ver `scripts/migrate-users-to-firestore.mjs`.

---

## Pasos para publicar en Vercel

### 1. Crear usuarios en Firebase

Antes de publicar, crea los usuarios de tu equipo en la consola de Firebase:

1. Ve a **Firebase Console → Authentication → Users → Add user**
2. Crea un usuario por persona (correo + contraseña)
3. Anota el **UID** de cada usuario (columna "User UID")

### 2. Crear perfiles en Firestore

Para cada usuario creado, ve a **Firestore Database** y crea un documento:

- **Colección:** `users`
- **ID del documento:** el UID del usuario
- **Campos:**

```
name: "Nombre Completo"
role: "jefe"           ← o "enfermera" o "visualizador"
center: "CITIO"         ← o "CIPI"
```

Las banderas opcionales (`puedeValidarInsumos`, `puedeEditarTratamientos`, `isMedico`) se agregan como campo booleano aparte, solo en la cuenta que las necesite (ver sección **Roles**).

### 3. Subir a GitHub

1. Crea una cuenta en [github.com](https://github.com) si no tienes
2. Crea un repositorio nuevo llamado `infusion-core`
3. Sube todos estos archivos al repositorio

### 4. Publicar en Vercel

1. Ve a [vercel.com](https://vercel.com) → Sign up with GitHub
2. **Add New Project** → selecciona `infusion-core`
3. Framework: **Vite** (Vercel lo detecta automático)
4. Clic en **Deploy**
5. En unos minutos tendrás una URL como `infusion-core.vercel.app`

### 5. Variables de entorno

En Vercel → tu proyecto → **Settings → Environment Variables**. Importante: Vercel separa el entorno **Production** (rama `main`) del **Preview** (cualquier otra rama, ej. `pruebas`) — si una variable solo se marca para uno de los dos, el otro falla en silencio con un error de "falta configurar X" aunque en Production sí funcione. Marca ambos entornos salvo que quieras probar algo solo en preview.

- `FIREBASE_SERVICE_ACCOUNT` — JSON completo de una cuenta de servicio (Firebase Console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada). La usan `api/generate-pdf.js` (hoja de tratamiento/bitácora) y `api/notify.js` (notificaciones push). El resto de las funciones en `api/` no la necesitan.
- Las variables `VITE_FIREBASE_*` (ver `src/config.js`) son opcionales si usas el proyecto de Firebase por defecto del código; solo hacen falta para apuntar a un proyecto distinto (ej. uno de pruebas separado).
- `VITE_FIRESTORE_DATABASE_ID` — opcional, por si el proyecto de Firebase tiene más de una base de datos Firestore dentro del mismo proyecto (ver paso 7).

Por higiene, cualquier clave de cuenta de servicio que se haya compartido fuera de Vercel (ej. para correr un script a mano) conviene regenerarla/revocarla después desde Firebase Console → Cuentas de servicio → Claves.

### 6. Configurar reglas de seguridad

Las reglas del repo (`firestore.rules` y `storage.rules`) se despliegan **manualmente** desde la consola de Firebase — no se publican solas al hacer push:

- Firebase Console → **Firestore Database → Rules** → pega el contenido de `firestore.rules`
- Firebase Console → **Storage → Rules** → pega el contenido de `storage.rules`

Si editas cualquiera de los dos archivos en el repo, recuerda desplegarlo también en la consola — de lo contrario el código y lo realmente desplegado se desincronizan.

### 7. Base de datos de pruebas (opcional)

El proyecto de Firebase puede tener dos bases de datos Firestore dentro del mismo proyecto: `(default)` (producción) y `pruebas` (para probar cambios sin tocar datos reales). Cuál usa la app se controla con la variable de entorno `VITE_FIRESTORE_DATABASE_ID`, configurada por rama en Vercel.

---

## Estructura del proyecto

```
src/
  config.js                   → Credenciales de Firebase y selección de base de datos (vía variables de entorno)
  firebase.js                 → Storage: subida de firmas (sesión y "Mi firma" personal)
  hooks/useAuth.jsx           → Contexto de autenticación (lee el perfil desde users/{uid})
  components/
    Layout.jsx                 → Menú lateral y navegación
    MaterialModal.jsx          → Modal "Solicitar material" (cálculo de piezas/insumos por sesión)
    MySignatureModal.jsx       → Captura de firma en archivo + cola de aprobación (jefe)
    SignaturePad.jsx           → Lienzo de captura de firma a mano
    UpdateBanner.jsx           → Aviso de nueva versión disponible
  pages/
    Login.jsx                  → Inicio de sesión
    Dashboard.jsx               → Panel general (jefe)
    NuevaSession.jsx             → Transcribir nueva orden (enfermera)
    Autorizar.jsx                 → Autorización de tratamientos (jefe)
    NurseView.jsx                  → Vista de pacientes del día (enfermera)
    Monitor.jsx                     → Monitor en tiempo real (jefe)
    Agenda.jsx                       → Esquemas de tratamiento y citas
    Insumos.jsx                       → Cálculo/solicitud de material y medicamentos, anexos, confirmaciones
    Inventario.jsx                     → Existencias, lotes, movimientos, solicitudes de compra por almacén
    Historial.jsx                       → Registro histórico de sesiones
    HistorialAnexo.jsx                   → Correcciones para trámites de seguro, sin tocar el historial real
    FichasTecnicas.jsx                    → Fichas técnicas de medicamentos (referencia clínica)
    Reportes.jsx                           → Estadísticas y exportación
    Auditoria.jsx                           → Bitácora de cambios (jefe)
    Catalogo.jsx                             → Catálogo de pacientes/médicos/diagnósticos, hoja de tratamiento
    Calculadoras.jsx                          → Calculadoras clínicas de apoyo
api/
  generate-pdf.js              → PDF de la hoja de tratamiento/bitácora (con firmas)
  generate-bitacora-anexo.js   → PDF de la bitácora con las correcciones de Historial anexo aplicadas
  generate-consent.js          → PDF del consentimiento informado
  generate-material-order.js   → PDF de solicitudes a farmacia (medicamentos/material/anexos/compra)
  notify.js                    → Notificaciones push (FCM)
scripts/
  migrate-users-to-firestore.mjs        → Alta/migración de usuarios
  backfill-past-cycles.mjs              → Genera citas estimadas de ciclos anteriores para esquemas ya en curso
```

---

## Flujo de uso

1. **Enfermera** inicia sesión → va a "Nueva sesión" → transcribe la orden del médico → envía
2. **Jefe** recibe notificación en "Autorizar" → revisa cada medicamento → aprueba o corrige → autoriza
3. **Enfermera** ve las correcciones en su vista → registra: ingreso del paciente → inicio/fin de cada medicamento → retiro
4. **Jefe** monitorea el avance de todos los pacientes en tiempo real desde "Monitor en vivo"
5. **Enfermera** calcula y solicita material/medicamentos por sesión (Insumos), o desde Inventario para reabasto general
6. Cada solicitud pasa por **firma a distancia** antes de considerarse completa (ver siguiente sección)

---

## Firma a distancia

El jefe no siempre está físicamente en el centro para firmar solicitudes de material y medicamentos en papel. Este sistema resuelve eso con firma en archivo y una cadena de validación que **nunca bloquea** la generación del documento — si falta una firma, el PDF sale con la leyenda "PENDIENTE VALIDACIÓN"/"PENDIENTE AUTORIZACIÓN" en su lugar, no se detiene el flujo.

**Firma en archivo** (`MySignatureModal.jsx`): cada usuario captura su firma una sola vez; queda guardada como imagen en Storage y se reutiliza en cada documento que genere, en vez de dibujarla cada vez. Un cambio de firma posterior pasa por aprobación del jefe (con registro de auditoría, auto-aprobado si quien cambia es el propio jefe). Cada documento generado **congela** la imagen de firma que existía en ese momento — si la firma cambia después, los documentos ya generados no se alteran retroactivamente.

**Cadena de validación**, según el tipo de solicitud:
- **Material/insumos** (por paciente): SOLICITA (quien guardó la solicitud) → VALIDA (checkup de Paola o el jefe) → RECIBE.
- **Medicamentos** (por paciente, y anexos que incluyan medicamento): SOLICITA → VALIDA → **AUTORIZA** (firma final del jefe, solo disponible una vez que ya se validó) → RECIBE.
- **Solicitudes de compra** (Inventario): misma cadena completa que medicamentos, sin importar si es medicamento o insumo — es dinero/reabasto de farmacia, no solo dispensar lo que ya hay.

Cualquier edición a una solicitud ya guardada invalida la validación/autorización que tuviera -- hay que volver a revisarla.

Importante: dar de baja insumos/medicamentos del inventario (descontar lo que ya se usó en una sesión) es independiente de esta cadena — no requiere que la validación/autorización ya se haya hecho, a propósito, para no bloquear el registro del consumo real.

---

## Inventario y trazabilidad por lote

Cada centro (CITIO, CIPI PRO, CIPI PED) tiene su propio almacén de existencias, más un almacén "Qual" (CITIO y CIPI por separado) que representa el stock que llega de la farmacia QualMedical antes de asignarse al centro.

- **Qual·CITIO/Qual·CIPI solo manejan medicamento** (nunca insumos/soluciones) y llevan lote, caducidad y marca por cada entrada.
- El lote se descuenta de Qual **el mismo día que se usa** en una sesión (al dar de baja medicamentos en Insumos), sin esperar a que llegue la cotización/factura oficial — es la única forma de que el número refleje la existencia física real. La entrada formal al almacén del centro, cuando llega la cotización, solo abona ahí (puede quedar en números rojos mientras tanto: "pendiente de compra").
- En CIPI, el tipo de atención (PED/PRO) se captura desde "Nueva sesión" (con precarga automática si ya hay una sesión previa del paciente) y determina de cuál de los dos almacenes Qual se descuenta.
- **Dar de baja** insumos y medicamentos son dos pasos independientes entre sí, y ambos independientes de la cadena de validación/autorización (ver sección anterior).
- Entrada de inventario: por XML de factura, por PDF de transferencia/cotización de QualMedical (se lee el texto del PDF), o pegando una lista copiada de Excel/Sheets (carga inicial de un almacén que nunca se había capturado).
- Mínimo/máximo por artículo: visible para toda enfermería (solo lectura), editable por jefe o quien tenga `puedeValidarInsumos`. En cuanto la existencia cae por debajo del mínimo se sugiere una compra del tamaño (máximo − mínimo).
- Reporte imprimible de existencias (con lote, caducidad, marca y mínimo/máximo) disponible por almacén desde Inventario.

---

## Historial anexo (trámites de seguro)

Pantalla aparte (`HistorialAnexo.jsx`), solo para jefe o la cuenta con `puedeEditarTratamientos`, que permite corregir fecha/ciclo/medicamentos de una sesión real, o capturar un ciclo que nunca se registró en la app — **sin tocar la sesión original** en `sessions`. Guarda todo en una colección separada (`historial_anexo`) como registro paralelo. Desde ahí se genera una bitácora en PDF con las correcciones ya aplicadas, idéntica en formato a la hoja de tratamiento normal, lista para el trámite de seguro.
