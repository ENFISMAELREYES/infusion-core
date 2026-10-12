// Extrae artículos (lote, caducidad, marca, cantidad) de una foto o
// escaneo SIN capa de texto -- complemento de handlePdfFile/handleXmlFile
// en Inventario.jsx para cuando solo se tiene el impreso físico que da el
// farmacéutico (y el archivo digital con costos llega días después). Usa
// un modelo con visión en vez de un parser de texto porque no hay texto
// que extraer de una imagen.
//
// No depende de credenciales de servidor de Firebase (mismo criterio que
// generate-consent.js / generate-material-order.js / el fix reciente en
// generate-bitacora-anexo.js) -- solo valida que quien llama esté
// autenticado, vía el mismo chequeo liviano contra Identity Toolkit.
//
// El modelo de visión se llama vía Vercel AI Gateway (endpoint compatible
// con el formato de OpenAI chat completions) en vez de pegarle directo a
// la API de Anthropic -- así el gasto queda facturado junto con Vercel, sin
// necesidad de una cuenta/tarjeta aparte en console.anthropic.com. Requiere
// la variable de entorno AI_GATEWAY_API_KEY (Vercel → Settings → AI Gateway
// → API Keys).

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { image, mimeType, token } = req.body;

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : token;
  if (!bearerToken) {
    return res.status(401).json({ error: "No autenticado: falta el token de sesión." });
  }
  try {
    const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";
    const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: bearerToken }),
    });
    if (!verifyRes.ok) return res.status(401).json({ error: "Token inválido o expirado." });
    const verifyData = await verifyRes.json();
    if (!verifyData.users || verifyData.users.length === 0) {
      return res.status(401).json({ error: "Token inválido." });
    }
  } catch (e) {
    return res.status(401).json({ error: "No se pudo verificar la sesión." });
  }

  if (!image || !mimeType) {
    return res.status(400).json({ error: "Falta la imagen." });
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    return res.status(500).json({ error: "Falta configurar AI_GATEWAY_API_KEY en el servidor." });
  }

  const PROMPT = `Esta imagen es una foto o escaneo de un comprobante/impreso de entrega de medicamentos de una farmacia (QualMedical). Extrae cada artículo/medicamento listado, con su lote, fecha de caducidad y cantidad.

Responde ÚNICAMENTE con un arreglo JSON (sin texto adicional, sin explicación, sin bloques de código \`\`\`), con exactamente este formato:
[{"descripcion": "nombre del medicamento tal como aparece impreso", "cantidad": <numero entero>, "lote": "texto del lote", "caducidad": "fecha tal como aparece impresa (DD/MM/AAAA o MES-AAAA)", "marca": "marca/laboratorio si aparece, si no, cadena vacía"}]

Si algún dato no es legible o no aparece en la imagen, usa "" para texto o 1 para cantidad. No inventes datos que no puedas leer con razonable certeza.`;

  try {
    const aiRes = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-5-5",
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${image}` } },
          ],
        }],
      }),
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => "");
      throw new Error(`Error del servicio de visión (${aiRes.status}): ${errBody.slice(0, 300)}`);
    }
    const aiData = await aiRes.json();
    let text = (aiData.choices?.[0]?.message?.content || "").trim();
    // El modelo a veces envuelve la respuesta en ```json ... ``` a pesar de
    // la instrucción -- se quita antes de parsear.
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    let items;
    try {
      items = JSON.parse(text);
    } catch (e) {
      throw new Error("No se pudo interpretar la respuesta del modelo de visión.");
    }
    if (!Array.isArray(items)) throw new Error("Respuesta inesperada del modelo de visión.");

    const cleaned = items.map(it => ({
      descripcion: String(it.descripcion || "").trim(),
      cantidad: parseInt(it.cantidad) || 1,
      lote: String(it.lote || "").trim(),
      caducidad: String(it.caducidad || "").trim(),
      marca: String(it.marca || "").trim(),
    })).filter(it => it.descripcion);

    if (cleaned.length === 0) {
      return res.status(422).json({ error: "No se encontraron artículos reconocibles en la imagen." });
    }
    res.status(200).json({ items: cleaned });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
