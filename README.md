# InfusionCore 🏥

Sistema de gestión para centros de infusión oncológica (CITIO y CIPI). Cubre todo el ciclo: transcripción de la orden médica, autorización, registro de la sesión del paciente en piso, cálculo y solicitud de material/medicamentos a farmacia, control de inventario, agenda de esquemas de tratamiento, y firma a distancia para las solicitudes que necesitan autorización del jefe sin que tenga que estar presente.

## Tecnologías
- React + Vite
- Firebase (Firestore, Authentication, Storage, Cloud Messaging)
- React Router
- PDFKit (generación de documentos, en funciones serverless de Vercel)

---

## Roles

- **jefe** → acceso total: autoriza tratamientos, monitorea en tiempo real, autoriza medicamentos/solicitudes de compra, administra el catálogo.
- **enfermera** → registra sesiones de sus pacientes, solicita material/medicamentos, da seguimiento a la agenda.
- **visualizador** → solo lectura (confirmaciones de asistencia), sin poder editar nada.

El perfil de cada usuario (`name`/`role`/`center`) vive en Firestore, en `users/{uid}` — no está hardcodeado en el código. Para dar de alta o migrar usuarios existentes, ver `scripts/migrate-users-to-firestore.mjs`.

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

### 5. Configurar reglas de seguridad

Las reglas del repo (`firestore.rules` y `storage.rules`) se despliegan **manualmente** desde la consola de Firebase — no se publican solas al hacer push:

- Firebase Console → **Firestore Database → Rules** → pega el contenido de `firestore.rules`
- Firebase Console → **Storage → Rules** → pega el contenido de `storage.rules`

Si editas cualquiera de los dos archivos en el repo, recuerda desplegarlo también en la consola — de lo contrario el código y lo realmente desplegado se desincronizan.

### 6. Base de datos de pruebas (opcional)

El proyecto de Firebase puede tener dos bases de datos Firestore dentro del mismo proyecto: `(default)` (producción) y `pruebas` (para probar cambios sin tocar datos reales). Cuál usa la app se controla con la variable de entorno `VITE_FIRESTORE_DATABASE_ID`, configurada por rama en Vercel.

---

## Estructura del proyecto

```
src/
  firebase/config.js         → Credenciales de Firebase y selección de base de datos
  hooks/useAuth.jsx          → Contexto de autenticación (lee el perfil desde users/{uid})
  firebase.js                → Storage: subida de firmas (sesión y "Mi firma" personal)
  components/
    Layout.jsx                → Menú lateral y navegación
    MaterialModal.jsx         → Modal "Solicitar material" (cálculo de piezas/insumos por sesión)
    MySignatureModal.jsx      → Captura de firma en archivo + cola de aprobación (jefe)
  pages/
    Login.jsx                 → Inicio de sesión
    Dashboard.jsx              → Panel general (jefe)
    NuevaSession.jsx           → Transcribir nueva orden (enfermera)
    Autorizar.jsx               → Autorización de tratamientos (jefe)
    NurseView.jsx               → Vista de pacientes del día (enfermera)
    Monitor.jsx                  → Monitor en tiempo real (jefe)
    Agenda.jsx                   → Esquemas de tratamiento y citas
    Insumos.jsx                   → Cálculo/solicitud de material y medicamentos, anexos, confirmaciones
    Inventario.jsx                 → Existencias, movimientos y solicitudes de compra por almacén
    Historial.jsx                   → Registro histórico de sesiones
    Reportes.jsx                     → Estadísticas y exportación
    Auditoria.jsx                     → Bitácora de cambios (jefe)
    Catalogo.jsx                      → Catálogo de material/medicamentos
    Calculadoras.jsx                   → Calculadoras clínicas de apoyo
api/
  generate-pdf.js              → PDF de la hoja de registro de la sesión (con firmas)
  generate-material-order.js   → PDF de solicitudes a farmacia (medicamentos/material/anexos/compra)
  notify.js                    → Notificaciones push (FCM)
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
