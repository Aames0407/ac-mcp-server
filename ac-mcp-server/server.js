import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const AC_API_KEY = process.env.AC_API_KEY;
const AC_API_URL = process.env.AC_API_URL; // z.B. https://anke-ames.api-us1.com
const PORT = process.env.PORT || 3000;

if (!AC_API_KEY || !AC_API_URL) {
  console.error('Fehler: AC_API_KEY und AC_API_URL müssen als Umgebungsvariablen gesetzt sein.');
  process.exit(1);
}

async function ac(method, endpoint, body = null) {
  const url = `${AC_API_URL}/api/3/${endpoint}`;
  const options = {
    method,
    headers: {
      'Api-Token': AC_API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

function createServer() {
  const server = new McpServer({
    name: 'activecampaign-write',
    version: '1.0.0',
  });

  // ── KONTAKTE ──────────────────────────────────────────────
  server.tool(
    'create_or_update_contact',
    'Kontakt in ActiveCampaign anlegen oder aktualisieren',
    {
      email: z.string().email().describe('E-Mail-Adresse'),
      firstName: z.string().optional().describe('Vorname'),
      lastName: z.string().optional().describe('Nachname'),
      phone: z.string().optional().describe('Telefonnummer'),
    },
    async ({ email, firstName, lastName, phone }) => {
      const data = await ac('POST', 'contact/sync', {
        contact: { email, firstName, lastName, phone },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data.contact) }] };
    }
  );

  server.tool(
    'add_contact_to_list',
    'Kontakt zu einer Liste hinzufügen',
    {
      contactId: z.string().describe('Kontakt-ID'),
      listId: z.string().describe('Listen-ID'),
      status: z.enum(['1', '2']).default('1').describe('1 = angemeldet, 2 = abgemeldet'),
    },
    async ({ contactId, listId, status }) => {
      const data = await ac('POST', 'contactLists', {
        contactList: { contact: contactId, list: listId, status },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.tool(
    'add_tag_to_contact',
    'Tag einem Kontakt zuweisen',
    {
      contactId: z.string().describe('Kontakt-ID'),
      tagId: z.string().describe('Tag-ID'),
    },
    async ({ contactId, tagId }) => {
      const data = await ac('POST', 'contactTags', {
        contactTag: { contact: contactId, tag: tagId },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  // ── TAGS ──────────────────────────────────────────────────
  server.tool(
    'create_tag',
    'Neuen Tag in ActiveCampaign erstellen',
    {
      tag: z.string().describe('Tag-Name'),
      description: z.string().optional().describe('Beschreibung des Tags'),
    },
    async ({ tag, description }) => {
      const data = await ac('POST', 'tags', {
        tag: { tag, tagType: 'contact', description: description || '' },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data.tag) }] };
    }
  );

  server.tool(
    'list_tags',
    'Alle Tags auflisten',
    { search: z.string().optional().describe('Nach Name filtern') },
    async ({ search }) => {
      const query = search ? `?search=${encodeURIComponent(search)}` : '';
      const data = await ac('GET', `tags${query}`);
      return { content: [{ type: 'text', text: JSON.stringify(data.tags) }] };
    }
  );

  // ── LISTEN ────────────────────────────────────────────────
  server.tool(
    'create_list',
    'Neue Kontaktliste anlegen',
    {
      name: z.string().describe('Name der Liste'),
      senderName: z.string().describe('Absendername (z.B. Anke Ames)'),
      senderUrl: z.string().describe('Webseite der Absenderin'),
      senderReminder: z.string().describe('Erinnerungstext warum jemand diese Mail erhält'),
    },
    async ({ name, senderName, senderUrl, senderReminder }) => {
      const data = await ac('POST', 'lists', {
        list: { name, sender_name: senderName, sender_url: senderUrl, sender_reminder: senderReminder },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data.list) }] };
    }
  );

  // ── KAMPAGNEN (Newsletter-Broadcasts) ─────────────────────
  server.tool(
    'create_campaign',
    'Neue E-Mail-Kampagne (Newsletter-Broadcast) anlegen',
    {
      name: z.string().describe('Interner Kampagnenname'),
      subject: z.string().describe('Betreffzeile der E-Mail'),
      fromName: z.string().describe('Absendername'),
      fromEmail: z.string().email().describe('Absender-E-Mail'),
      replyTo: z.string().email().describe('Antwort-E-Mail'),
      listIds: z.array(z.string()).describe('IDs der Empfängerlisten'),
      htmlBody: z.string().describe('HTML-Inhalt der E-Mail'),
      plainTextBody: z.string().optional().describe('Nur-Text-Version'),
    },
    async ({ name, subject, fromName, fromEmail, replyTo, listIds, htmlBody, plainTextBody }) => {
      const campaign = await ac('POST', 'campaigns', {
        campaign: {
          type: 'single',
          name,
          status: 0,
          public: 0,
          tracklinks: 'all',
          tracklinksanalytics: 0,
          trackreads: 1,
          trackreadsanalytics: 0,
          lists: listIds,
        },
      });

      const campaignId = campaign.campaign.id;

      const message = await ac('POST', 'messages', {
        message: {
          fromemail: fromEmail,
          fromname: fromName,
          reply2: replyTo,
          subject,
          preheader_text: '',
          html: htmlBody,
          text: plainTextBody || '',
          campaign: campaignId,
          mime_type: 'text/html',
        },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ campaign: campaign.campaign, message: message.message }),
        }],
      };
    }
  );

  server.tool(
    'schedule_campaign',
    'Kampagne zum Versand einplanen',
    {
      campaignId: z.string().describe('Kampagnen-ID'),
      sendDate: z.string().describe('Sendezeitpunkt im Format: 2026-07-25 10:00:00'),
    },
    async ({ campaignId, sendDate }) => {
      const data = await ac('PUT', `campaigns/${campaignId}`, {
        campaign: { status: 1, sdate: sendDate },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data.campaign) }] };
    }
  );

  server.tool(
    'list_campaigns',
    'Kampagnen auflisten',
    { limit: z.number().optional().default(20) },
    async ({ limit }) => {
      const data = await ac('GET', `campaigns?limit=${limit}&orders[sdate]=DESC`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.campaigns?.map(c => ({
            id: c.id, name: c.name, subject: c.subject, status: c.status, sdate: c.sdate,
          }))),
        }],
      };
    }
  );

  // ── AUTOMATIONEN ──────────────────────────────────────────
  server.tool(
    'list_automations',
    'Alle Automationen auflisten',
    {},
    async () => {
      const data = await ac('GET', 'automations?limit=50');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.automations?.map(a => ({
            id: a.id, name: a.name, status: a.status, contacts: a.contactGoalLists,
          }))),
        }],
      };
    }
  );

  server.tool(
    'add_contact_to_automation',
    'Kontakt in eine Automation einschreiben (startet die Sequenz)',
    {
      contactId: z.string().describe('Kontakt-ID'),
      automationId: z.string().describe('Automations-ID'),
    },
    async ({ contactId, automationId }) => {
      const data = await ac('POST', 'contactAutomations', {
        contactAutomation: { contact: contactId, automation: automationId },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  return server;
}

// ── EXPRESS + MCP HTTP TRANSPORT ──────────────────────────
const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  res.status(405).json({ error: 'Method not allowed' });
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'ac-mcp-server' }));

app.listen(PORT, () => {
  console.log(`AC MCP Server läuft auf Port ${PORT}`);
});
