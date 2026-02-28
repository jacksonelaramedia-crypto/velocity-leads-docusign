const crypto = require('crypto');

const SCOPES = 'signature impersonation';

function generateJWT(integrationKey, userId, privateKey, isProduction) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const authServer = isProduction ? 'account.docusign.com' : 'account-d.docusign.com';
  const payload = {
    iss: integrationKey,
    sub: userId,
    aud: authServer,
    iat: now,
    exp: now + 3600,
    scope: SCOPES,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = b64(header) + '.' + b64(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');
  return signingInput + '.' + signature;
}

async function getAccessToken(integrationKey, userId, privateKey, isProduction) {
  const authServer = isProduction ? 'account.docusign.com' : 'account-d.docusign.com';
  const jwt = generateJWT(integrationKey, userId, privateKey, isProduction);
  const res = await fetch('https://' + authServer + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Auth failed: ' + res.status + ' ' + err);
  }
  const data = await res.json();
  return data.access_token;
}

async function sendEnvelope(accessToken, accountId, baseUri, opts) {
  const envelopeBody = {
    emailSubject: 'Velocity Leads Service Agreement - ' + opts.clientName,
    emailBlurb: opts.signerMessage || ('Hi ' + opts.clientName + ', please review and sign the attached Service Agreement from Velocity Leads.'),
    documents: [
      {
        documentBase64: opts.docBase64,
        name: opts.fileName,
        fileExtension: 'docx',
        documentId: '1',
      },
    ],
    recipients: {
      signers: [
        {
          email: opts.clientEmail,
          name: opts.clientName,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              {
                anchorString: 'Signature: ___',
                anchorUnits: 'pixels',
                anchorXOffset: '100',
                anchorYOffset: '-5',
              },
            ],
          },
        },
      ],
    },
    status: 'sent',
  };
  var url = baseUri + '/restapi/v2.1/accounts/' + accountId + '/envelopes';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(envelopeBody),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Envelope creation failed: ' + res.status + ' ' + err);
  }
  return await res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    var body = req.body || {};
    var docBase64 = body.docBase64;
    var fileName = body.fileName;
    var clientName = body.clientName;
    var clientEmail = body.clientEmail;
    var signerMessage = body.signerMessage;

    if (!docBase64 || !clientName || !clientEmail) {
      return res.status(400).json({ error: 'Missing required fields: docBase64, clientName, clientEmail' });
    }

    var integrationKey = process.env.DS_INTEGRATION_KEY;
    var userId = process.env.DS_USER_ID;
    var accountId = process.env.DS_ACCOUNT_ID;
    var rawKey = process.env.DS_PRIVATE_KEY || '';
    var privateKey = rawKey.replace(/\\n/g, '\n');
    var baseUri = process.env.DS_BASE_URI || 'https://demo.docusign.net';
    var isProduction = baseUri.indexOf('demo') === -1;

    if (!integrationKey || !userId || !accountId || !rawKey) {
      return res.status(500).json({ error: 'Server misconfigured: missing environment variables' });
    }

    var accessToken = await getAccessToken(integrationKey, userId, privateKey, isProduction);

    var result = await sendEnvelope(accessToken, accountId, baseUri, {
      docBase64: docBase64,
      fileName: fileName || 'Service Agreement.docx',
      clientName: clientName,
      clientEmail: clientEmail,
      signerMessage: signerMessage,
    });

    return res.status(200).json({
      success: true,
      envelopeId: result.envelopeId,
      status: result.status,
      message: 'Agreement sent to ' + clientEmail,
    });
  } catch (err) {
    console.error('DocuSign error:', err);
    return res.status(500).json({ error: err.message });
  }
};
