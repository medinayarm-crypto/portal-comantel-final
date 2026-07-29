const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

module.exports = async (req, res) => {
  const doc = req.query.doc;
  if (!doc) return res.status(400).json({ ok: false, message: "Falta cédula" });

  const baseUrl = process.env.URL_FACTURACION || 'https://wisphub.io';
  const apiKey = process.env.KEY_FACTURACION;
  const adminCedula = process.env.ADMIN_CEDULA;

  if (!apiKey) return res.status(500).json({ ok: false, message: "KEY_FACTURACION no configurada" });

  // Acceso admin por cédula
  if (adminCedula && doc === adminCedula) {
    return res.status(200).json({ ok: true, isAdmin: true, message: "Acceso administrativo concedido" });
  }

  try {
    let clientEmail = null;
    let clientName = null;
    const cacheKey = `cedula:${doc}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      clientEmail = cached.email;
      clientName = cached.name;
      console.log(`📦 Caché hit: ${doc} → ${clientEmail}`);
    } else {
      // PASO 1: Obtener lista de clientes y buscar por DNI en el HTML
      console.log(`🔍 Buscando cédula ${doc} en lista de clientes...`);
      const listRes = await fetch(`${baseUrl}/clientes/`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Cookie': `session=${apiKey}`, // Wisphub puede usar cookie en vez de Bearer
          'Accept': 'text/html'
        }
      });

      if (!listRes.ok) throw new Error(`Error accediendo a /clientes/: ${listRes.status}`);

      const html = await listRes.text();

      // Buscar patrón: DNI/C.I. seguido de email @comantel en la misma fila de tabla
      // Según captura: "20168749 ... giselamontoro@comantel ... Gisela Del Carmen ..."
      const dniRegex = new RegExp(
        `${doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,500}?([a-zA-Z0-9._-]+@comantel)[\\s\\S]{0,200}?(?:<td[^>]*>([^<]*)</td>)?`,
        'i'
      );
      const match = html.match(dniRegex);

      if (match && match[1]) {
        clientEmail = match[1];
        clientName = match[2]?.trim() || clientEmail.split('@')[0];
        console.log(`✅ Cliente encontrado: ${clientName} (${clientEmail})`);
      } else {
        // Intento alternativo: buscar email @comantel cerca de la cédula
        const altRegex = new RegExp(
          `([a-zA-Z0-9._-]+@comantel)[\\s\\S]{0,300}?${doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          'i'
        );
        const altMatch = html.match(altRegex);
        if (altMatch && altMatch[1]) {
          clientEmail = altMatch[1];
          clientName = clientEmail.split('@')[0];
          console.log(`✅ Cliente encontrado (búsqueda inversa): ${clientName} (${clientEmail})`);
        }
      }

      if (!clientEmail) {
        return res.status(404).json({
          ok: false,
          message: `No se encontró cliente con cédula ${doc}. Verifica que esté registrada en Wisphub.`
        });
      }

      cache.set(cacheKey, { email: clientEmail, name: clientName, timestamp: Date.now() });
    }

    // PASO 2: Obtener historial de pagos desde /pagos/ filtrado por cliente
    console.log(`📋 Obteniendo pagos para ${clientEmail}...`);
    const pagosRes = await fetch(`${baseUrl}/pagos/?buscar=${encodeURIComponent(clientEmail)}&estado=pendiente`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Cookie': `session=${apiKey}`,
        'Accept': 'text/html'
      }
    });

    let pendingInvoices = [];
    let totalPending = 0;

    if (pagosRes.ok) {
      const pagosHtml = await pagosRes.text();
      // Extraer filas de tabla de pagos pendientes
      // Patrón: #Factura | Cliente | Estado Factura | Total
      const invoiceRegex = /#(\d+)[\s\S]{0,100}?Pendiente de pago[\s\S]{0,100}?\$(\d+(?:\.\d{2})?)/gi;
      let invMatch;
      while ((invMatch = invoiceRegex.exec(pagosHtml)) !== null) {
        const amount = parseFloat(invMatch[2]);
        pendingInvoices.push({
          factura: invMatch[1],
          monto: amount,
          estado: 'Pendiente de pago'
        });
        totalPending += amount;
      }
      console.log(`📊 Encontradas ${pendingInvoices.length} facturas pendientes`);
    }

    // Respuesta al frontend
    res.status(200).json({
      ok: true,
      isAdmin: false,
      client_name: clientName,
      cedula: doc,
      invoices: pendingInvoices,
      pending_invoices: pendingInvoices,
      processed_invoices: [],
      total_pending: totalPending,
      processed_count: 0,
      pending_count: pendingInvoices.length,
      bank_data: {
        bnc: { telefono: process.env.BNC_TELEFONO || '-', cedula: process.env.BNC_CEDULA || '-' },
        banplus: { telefono: process.env.BANPLUS_TELEFONO || '-', cedula: process.env.BANPLUS_CEDULA || '-' }
      }
    });

  } catch (error) {
    console.error('💥 Error fatal:', error.message);
    res.status(500).json({ ok: false, message: error.message });
  }
};
