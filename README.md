# InfusionCore 🏥

Sistema de gestión para centros de infusión. Permite a las enfermeras registrar órdenes de tratamiento y al jefe de enfermería revisarlas, autorizarlas y monitorear el avance en tiempo real.

## Tecnologías
- React + Vite
- Firebase (Firestore + Authentication)
- React Router

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
role: "jefe"           ← o "enfermera"
center: "Centro Norte" ← o "Centro Sur"
```

Roles disponibles:
- `jefe` → accede al panel general, monitor y autorización
- `enfermera` → accede a sus pacientes y registro de turnos

### 3. Subir a GitHub

1. Crea una cuenta en [github.com](https://github.com) si no tienes
2. Crea un repositorio nuevo llamado `infusion-core`
3. Sube todos estos archivos al repositorio

### 4. Publicar en Vercel

1. Ve a [vercel.com](https://vercel.com) → Sign up with GitHub
2. **Add New Project** → selecciona `infusion-core`
3. Framework: **Vite** (Vercel lo detecta automático)
4. Clic en **Deploy**
5. En 2 minutos tendrás una URL como `infusion-core.vercel.app`

### 5. Configurar reglas de Firestore

En Firebase Console → Firestore → **Rules**, pega el contenido del archivo `firestore.rules`.

---

## Estructura del proyecto

```
src/
  firebase/config.js     → Credenciales de Firebase
  hooks/useAuth.jsx      → Contexto de autenticación
  components/Layout.jsx  → Menú lateral y navegación
  pages/
    Login.jsx            → Pantalla de inicio de sesión
    Dashboard.jsx        → Panel general (jefe)
    Autorizar.jsx        → Autorización de tratamientos (jefe)
    Monitor.jsx          → Monitor en tiempo real (jefe)
    NurseView.jsx        → Vista de pacientes (enfermera)
    NuevaSession.jsx     → Transcribir nueva orden (enfermera)
```

---

## Flujo de uso

1. **Enfermera** inicia sesión → va a "Nueva sesión" → transcribe la orden del médico → envía
2. **Jefe** recibe notificación en "Autorizar" → revisa cada medicamento → aprueba o corrige → autoriza
3. **Enfermera** ve las correcciones en su vista → registra: ingreso del paciente → inicio/fin de cada medicamento → retiro
4. **Jefe** monitorea el avance de todos los pacientes en tiempo real desde "Monitor en vivo"
