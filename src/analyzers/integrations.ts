/** Detects external services the project talks to, from dependencies, code and env keys. */
import { ScanContext } from '../core/context';
import { GraphBuilder } from '../schema/builder';
import { LineIndex, squash } from '../utils/text';
import { stripPhp } from '../parsers/php';
import { stripJs } from '../parsers/js';

const DOCS = /(^|\/)(docs?|documentation|\d*_?docs?|wiki|examples?|tests?|__tests__|spec|fixtures)\//i;

/** Source with comments blanked (offsets preserved), so commented-out config is not evidence. */
function codeOnly(path: string, src: string): string {
  if (path.endsWith('.php')) return stripPhp(src);
  if (/\.(m?js|cjs|ts|tsx|jsx|vue)$/.test(path)) return stripJs(src);
  if (/\.(py|ya?ml|env\.example)$|\.env\.example$/.test(path)) return src.replace(/(^|\s)#.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
  return src;
}

interface Rule {
  id: string;
  name: string;
  category: string;
  deps?: RegExp;
  code?: RegExp;
}

const RULES: Rule[] = [
  { id: 'stripe', name: 'Stripe', category: 'Payments', deps: /^(stripe|stripe\/stripe-php|@stripe\/.+)$/, code: /\bStripe\\|\bstripe\.(?:checkout|charges|paymentIntents|customers)|api\.stripe\.com|STRIPE_(?:SECRET|KEY)/ },
  { id: 'razorpay', name: 'Razorpay', category: 'Payments', deps: /^(razorpay|razorpay\/razorpay)$/, code: /\bRazorpay\b|checkout\.razorpay\.com|RAZORPAY_KEY/ },
  { id: 'paypal', name: 'PayPal', category: 'Payments', deps: /paypal/i, code: /api(?:-m)?\.(?:sandbox\.)?paypal\.com|PAYPAL_CLIENT/ },
  { id: 'cashfree', name: 'Cashfree', category: 'Payments', deps: /cashfree/i, code: /cashfree\.com|CASHFREE_/ },
  { id: 'phonepe', name: 'PhonePe', category: 'Payments', code: /phonepe\.com|PHONEPE_/ },
  { id: 'smtp', name: 'Email (SMTP / mailer)', category: 'Email', deps: /^(phpmailer\/phpmailer|nodemailer|symfony\/mailer|django-anymail|flask-mail|fastapi-mail)$/, code: /\bSMTPHost\b|MAIL_HOST|EMAIL_HOST\b|\bsmtplib\b|nodemailer\.createTransport|Services::email\(/ },
  { id: 'sendgrid', name: 'SendGrid', category: 'Email', deps: /sendgrid/i, code: /api\.sendgrid\.com|SENDGRID_API_KEY/ },
  { id: 'mailgun', name: 'Mailgun', category: 'Email', deps: /mailgun/i, code: /api\.mailgun\.net|MAILGUN_/ },
  { id: 'ses', name: 'Amazon SES', category: 'Email', code: /\bSesClient\b|boto3\.client\(\s*['"]ses|@aws-sdk\/client-ses/ },
  { id: 'twilio', name: 'Twilio', category: 'SMS / messaging', deps: /twilio/i, code: /api\.twilio\.com|TWILIO_/ },
  { id: 'msg91', name: 'MSG91', category: 'SMS / messaging', code: /api\.msg91\.com|control\.msg91\.com|MSG91_/ },
  { id: 'fast2sms', name: 'Fast2SMS', category: 'SMS / messaging', code: /fast2sms\.com/ },
  { id: 'textlocal', name: 'Textlocal', category: 'SMS / messaging', code: /api\.textlocal\.in/ },
  { id: 'whatsapp', name: 'WhatsApp (Cloud API / links)', category: 'SMS / messaging', code: /graph\.facebook\.com\/v[\d.]+\/\d+\/messages|wa\.me\/|api\.whatsapp\.com|WHATSAPP_/ },
  { id: 'aws-s3', name: 'Amazon S3', category: 'Storage', deps: /^(aws\/aws-sdk-php|boto3|@aws-sdk\/client-s3|aws-sdk|django-storages|league\/flysystem-aws-s3-v3)$/, code: /\bS3Client\b|boto3\.(?:client|resource)\(\s*['"]s3|\.s3\.amazonaws\.com|AWS_BUCKET|AWS_STORAGE_BUCKET_NAME/ },
  { id: 'gcs', name: 'Google Cloud Storage', category: 'Storage', deps: /google-cloud-storage|@google-cloud\/storage/, code: /storage\.googleapis\.com/ },
  { id: 'cloudinary', name: 'Cloudinary', category: 'Storage', deps: /cloudinary/i, code: /res\.cloudinary\.com|CLOUDINARY_/ },
  { id: 'firebase', name: 'Firebase', category: 'Cloud / push', deps: /^(firebase|firebase-admin|kreait\/firebase-php|kreait\/laravel-firebase)$/, code: /firebaseio\.com|fcm\.googleapis\.com|firebase\.initializeApp|FIREBASE_/ },
  { id: 'onesignal', name: 'OneSignal', category: 'Cloud / push', code: /onesignal\.com/ },
  { id: 'google-oauth', name: 'Google Sign-In / OAuth', category: 'Auth', deps: /^(google\/apiclient|google-auth-library|social-auth-app-django|django-allauth|laravel\/socialite|passport-google-oauth20)$/, code: /accounts\.google\.com\/o\/oauth2|GOOGLE_CLIENT_ID|apis\.google\.com\/js\/platform|gsi\/client/ },
  { id: 'jwt', name: 'JWT tokens', category: 'Auth', deps: /^(firebase\/php-jwt|jsonwebtoken|pyjwt|djangorestframework-simplejwt|python-jose|tymon\/jwt-auth)$/i, code: /\bJWT::(?:encode|decode)|jwt\.(?:sign|verify|encode|decode)\(/ },
  { id: 'recaptcha', name: 'Google reCAPTCHA', category: 'Auth', code: /google\.com\/recaptcha|RECAPTCHA_|g-recaptcha/ },
  { id: 'openai', name: 'OpenAI', category: 'AI', deps: /^(openai|openai-php\/client|openai-php\/laravel)$/, code: /api\.openai\.com|OPENAI_API_KEY/ },
  { id: 'anthropic', name: 'Anthropic Claude', category: 'AI', deps: /^(anthropic|@anthropic-ai\/sdk)$/, code: /api\.anthropic\.com|ANTHROPIC_API_KEY/ },
  { id: 'gemini', name: 'Google Gemini', category: 'AI', deps: /google-generativeai|@google\/generative-ai|google-genai/, code: /generativelanguage\.googleapis\.com|GEMINI_API_KEY/ },
  { id: 'google-maps', name: 'Google Maps', category: 'Maps', code: /maps\.googleapis\.com|maps\.google\.com\/maps\/api/ },
  { id: 'google-analytics', name: 'Google Analytics / Tag Manager', category: 'Analytics', code: /googletagmanager\.com|google-analytics\.com|gtag\(\s*['"]config/ },
  { id: 'meta-pixel', name: 'Meta (Facebook) Pixel', category: 'Analytics', code: /connect\.facebook\.net\/[\w_]+\/fbevents\.js|fbq\(\s*['"]init/ },
  { id: 'sentry', name: 'Sentry', category: 'Monitoring', deps: /sentry/i, code: /\.ingest\.sentry\.io|SENTRY_DSN/ },
  { id: 'redis', name: 'Redis', category: 'Data store', deps: /^(redis|ioredis|predis\/predis|django-redis|aioredis)$/, code: /REDIS_(?:HOST|URL)|new\s+Redis\(|redis:\/\// },
  { id: 'mongodb', name: 'MongoDB', category: 'Data store', deps: /^(mongoose|mongodb|pymongo|motor|mongoengine|jenssegers\/mongodb)$/, code: /mongodb(?:\+srv)?:\/\// },
  { id: 'postgres', name: 'PostgreSQL', category: 'Data store', deps: /^(pg|psycopg2|psycopg2-binary|psycopg|asyncpg)$/, code: /postgres(?:ql)?:\/\/|django\.db\.backends\.postgresql|DBDriver['"]?\s*=>?\s*['"]Postgre/ },
  { id: 'mysql', name: 'MySQL / MariaDB', category: 'Data store', deps: /^(mysql|mysql2|mysqlclient|pymysql|aiomysql)$/, code: /mysql:\/\/|django\.db\.backends\.mysql|DBDriver['"]?\s*=>?\s*['"]MySQLi|\bmysqli_connect\(|new\s+mysqli\(|mysql:host=/ },
  { id: 'sqlite', name: 'SQLite', category: 'Data store', deps: /^(sqlite3|better-sqlite3)$/, code: /django\.db\.backends\.sqlite3|sqlite:\/\/\/|DBDriver['"]?\s*=>?\s*['"]SQLite3/ },
  { id: 'elasticsearch', name: 'Elasticsearch', category: 'Data store', deps: /elasticsearch|@elastic\/elasticsearch/, code: /:9200\b/ },
  { id: 'celery', name: 'Celery', category: 'Background jobs', deps: /^celery$/, code: /@shared_task|@app\.task|Celery\(/ },
  { id: 'queue', name: 'Queue worker (Bull / RabbitMQ / SQS)', category: 'Background jobs', deps: /^(bull|bullmq|amqplib|pika|kombu|php-amqplib\/php-amqplib)$/, code: /amqp:\/\/|sqs\.[\w-]+\.amazonaws\.com/ },
  { id: 'pdf', name: 'PDF generation', category: 'Documents', deps: /^(mpdf\/mpdf|dompdf\/dompdf|tecnickcom\/tcpdf|barryvdh\/laravel-dompdf|reportlab|weasyprint|xhtml2pdf|pdfkit|puppeteer|jspdf)$/, code: /new\s+\\?Mpdf\\Mpdf|new\s+Dompdf/ },
  { id: 'spreadsheet', name: 'Excel / spreadsheets', category: 'Documents', deps: /^(phpoffice\/phpspreadsheet|maatwebsite\/excel|openpyxl|xlsxwriter|pandas|exceljs|xlsx)$/i },
  { id: 'slack', name: 'Slack', category: 'Notifications', code: /hooks\.slack\.com|SLACK_WEBHOOK/ },
  { id: 'telegram', name: 'Telegram Bot API', category: 'Notifications', code: /api\.telegram\.org/ },
];

const CODE_EXT = /\.(php|py|js|mjs|cjs|ts|tsx|jsx|vue|html|twig|ejs|env\.example|example|ya?ml|json)$|(^|\/)\.env\.example$/;

export function analyzeIntegrations(ctx: ScanContext, g: GraphBuilder): void {
  const add = (r: Rule, file: string, line: number | undefined, text: string) => {
    let node = g.integrations.get(`integration:${r.id}`);
    if (!node) {
      node = { id: `integration:${r.id}`, name: r.name, category: r.category, evidence: [] };
      g.integrations.set(node.id, node);
    }
    if (node.evidence.length < 8 && !node.evidence.some((e) => e.file === file && e.line === line)) node.evidence.push({ file, line, text: squash(text, 140) });
  };
  for (const d of g.dependencies) {
    for (const r of RULES) if (r.deps && r.deps.test(d.name)) add(r, d.manifest, undefined, `dependency ${d.name} ${d.version}`);
  }
  for (const f of ctx.files) {
    if (!CODE_EXT.test(f.path) || f.size > 600_000 || /\.min\.js$|lock\.json$|composer\.lock$/.test(f.path) || DOCS.test(f.path)) continue;
    const raw = ctx.read(f.path);
    if (!raw) continue;
    const src = codeOnly(f.path, raw);
    let lines: LineIndex | undefined;
    for (const r of RULES) {
      if (!r.code) continue;
      const node = g.integrations.get(`integration:${r.id}`);
      if (node && node.evidence.length >= 8) continue;
      const m = r.code.exec(src);
      if (!m) continue;
      lines = lines || new LineIndex(src);
      const line = lines.lineAt(m.index);
      const lineText = raw.split('\n')[line - 1] || m[0];
      add(r, f.path, line, redact(lineText));
    }
  }
}

/** Never let evidence lines carry credentials. */
export function redact(line: string): string {
  return line
    .replace(/((?:key|secret|token|password|passwd|pwd|auth|dsn|credential)[\w-]*['"]?\s*(?:=>|=|:)\s*['"])([^'"]{4,})(['"])/gi, '$1***$3')
    .replace(/(sk_(?:live|test)_|rzp_(?:live|test)_|AKIA|AIza|xox[bpa]-|ghp_|SG\.)[\w\-.]+/g, '$1***')
    .replace(/(:\/\/[^:\s/]+:)[^@\s]+@/g, '$1***@');
}
