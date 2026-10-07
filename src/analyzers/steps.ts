/**
 * Turns a handler body into a readable list of execution steps, plus the
 * data access, views and response kinds it implies. Works per language;
 * adapters pass a resolver so model names map to the project's real models.
 */
import { DataAccess, DataOp, Step, StepKind, ViewRef } from '../schema/graph';
import { matchBracket, skipString, splitTopLevel, unquote } from '../parsers/common';
import { arrayKeys } from '../parsers/php';
import { sqlTableRefs } from '../parsers/sql';
import { squash, uniq } from '../utils/text';

export type Lang = 'php' | 'python' | 'js';

export interface StepContext {
  lang: Lang;
  /** Maps a receiver expression ("$this->userModel", "User", "Product.objects") to a model name. */
  resolveModel(expr: string): string | undefined;
  /** Model name → table name. */
  modelTable(model: string): string | undefined;
  /** Names of sibling methods/functions, to describe internal calls. */
  siblings?: Set<string>;
}

export interface BodyAnalysis {
  steps: Step[];
  data: DataAccess[];
  views: Array<{ name: string; vars: string[]; line: number }>;
  responses: string[];
  models: string[];
  tables: string[];
  redirects: string[];
}

interface Statement {
  text: string;
  line: number;
}

const MAX_STEPS = 80;

const READ = new Set(['find', 'findAll', 'first', 'firstOrFail', 'findOrFail', 'get', 'paginate', 'simplePaginate', 'all', 'filter', 'exclude',
  'findOne', 'findById', 'findByPk', 'findMany', 'findUnique', 'findFirst', 'count', 'countAll', 'countAllResults', 'exists', 'pluck', 'value',
  'getResult', 'getResultArray', 'getRow', 'getRowArray', 'values', 'values_list', 'aggregate', 'annotate', 'scalars', 'scalar', 'one',
  'one_or_none', 'first_or_404', 'get_or_404', 'chunk', 'cursor', 'lean', 'distinct', 'sum', 'avg', 'max', 'min', 'getWhere', 'getCompiledSelect',
  'select_related', 'prefetch_related', 'order_by', 'latest', 'earliest', 'in_bulk', 'iterator', 'findAndCountAll', 'aggregate', 'groupBy', 'retrieve']);
const WRITE = new Set(['insert', 'insertBatch', 'insertGetId', 'save', 'create', 'update', 'updateBatch', 'upsert', 'updateOrCreate',
  'firstOrCreate', 'firstOrNew', 'get_or_create', 'update_or_create', 'bulk_create', 'bulk_update', 'increment', 'decrement', 'replace',
  'insertMany', 'insertOne', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'createMany', 'attach', 'sync', 'detach',
  'associate', 'push', 'add', 'merge', 'bulkCreate', 'saveMany', 'set', 'touch', 'restore', 'forceFill', 'fill', 'updateAll', 'upsertMany']);
const DELETE = new Set(['delete', 'destroy', 'remove', 'deleteOne', 'deleteMany', 'truncate', 'findByIdAndDelete', 'findOneAndDelete',
  'emptyTable', 'purgeDeleted', 'forceDelete', 'deleteAll']);

export function opOfChain(chain: string): DataOp {
  const verbs = Array.from(chain.matchAll(/[.>]\s*(\w+)\s*\(/g)).map((m) => m[1]);
  for (let i = verbs.length - 1; i >= 0; i--) {
    const v = verbs[i];
    if (DELETE.has(v)) return 'delete';
    if (WRITE.has(v)) return 'write';
    if (READ.has(v)) return 'read';
  }
  // custom model methods: infer from the verb prefix of the last call
  const last = verbs[verbs.length - 1] || '';
  if (/^(delete|remove|destroy|purge|clear|drop)/i.test(last)) return 'delete';
  if (/^(save|insert|update|create|add|set|store|log|record|upsert|increment|decrement|mark|attach|sync|bulk|write|put|append|assign|apply|reset|toggle)/i.test(last)) return 'write';
  if (/^(get|find|fetch|list|count|search|load|all|exists|has|is|sum|total|read|lookup|resolve|select|paginate|first|latest|recent|summary|report|stats)/i.test(last)) return 'read';
  return 'access';
}

const OP_LABEL: Record<DataOp, string> = { read: 'READ', write: 'WRITE', delete: 'DELETE', access: 'USE' };

/** Splits a brace-language body into statements with line numbers. */
function braceStatements(body: string, lineOf: (offset: number) => number, quotes: string): Statement[] {
  const out: Statement[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const raw = body.slice(start, end);
    const lead = raw.search(/\S/);
    if (lead >= 0) out.push({ text: raw.trim(), line: lineOf(start + lead) });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quotes.includes(c)) {
      i = skipString(body, i);
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      push(c === '{' ? i + 1 : i);
      start = i + 1;
    }
  }
  push(body.length);
  return out;
}

interface Rule {
  re: RegExp;
  kind: StepKind;
  text: (m: RegExpExecArray) => string;
  response?: string;
}

const COMMON_PHP: Rule[] = [
  { re: /->getMethod\(\)|->isMethod\(|\$_SERVER\[['"]REQUEST_METHOD['"]\]|->is\(\s*['"]post['"]/i, kind: 'branch', text: () => 'Branches on the HTTP method' },
  { re: /->(?:getPost|input|post)\(\s*['"]([\w.\-\[\]]+)['"]/, kind: 'input', text: (m) => `Reads request field '${m[1]}'` },
  { re: /->(?:getGet|query)\(\s*['"]([\w.\-]+)['"]/, kind: 'input', text: (m) => `Reads query parameter '${m[1]}'` },
  { re: /->getVar\(\s*['"]([\w.\-]+)['"]/, kind: 'input', text: (m) => `Reads request variable '${m[1]}'` },
  { re: /->(?:getFile|getFiles|file|allFiles)\(\s*['"]?([\w.\-]*)['"]?/, kind: 'input', text: (m) => `Reads uploaded file${m[1] ? ` '${m[1]}'` : 's'}` },
  { re: /->(?:getJSON|json)\(/, kind: 'input', text: () => 'Reads the JSON request body' },
  { re: /->(?:getPost|getPostGet|getRawInput|all|validated|safe)\(\s*\)/, kind: 'input', text: () => 'Reads all submitted fields' },
  { re: /\brequest\(\s*['"]([\w.\-]+)['"]/, kind: 'input', text: (m) => `Reads request field '${m[1]}'` },
  { re: /\$_(POST|GET|REQUEST|FILES|COOKIE)\[\s*['"]([\w\-]+)['"]/, kind: 'input', text: (m) => `Reads $_${m[1]}['${m[2]}']` },
  { re: /->(?:getHeaderLine|header|getHeader)\(\s*['"]([\w\-]+)['"]/, kind: 'input', text: (m) => `Reads header '${m[1]}'` },
  { re: /->getIPAddress\(\)|->ip\(\)/, kind: 'input', text: () => 'Reads the client IP address' },
  { re: /->validate\(|Validator::make\(|->setRules\(|->withRequest\(|validation->run\(|->validateData\(|\$this->validate\(/, kind: 'validate', text: () => 'Validates input' },
  { re: /\bpassword_verify\(|Hash::check\(/, kind: 'auth', text: () => 'Verifies a password hash' },
  { re: /\bpassword_hash\(|Hash::make\(|bcrypt\(/, kind: 'auth', text: () => 'Hashes a password' },
  { re: /\bAuth::(attempt|login|logout|user|id|check)\(|\bauth\(\)->(attempt|login|logout|user|id|check)\(/, kind: 'auth', text: (m) => `Auth ${m[1] || m[2]}()` },
  { re: /->authorize\(|Gate::(allows|denies|authorize)|->can\(/, kind: 'auth', text: () => 'Checks an authorization policy' },
  { re: /JWT::(encode|decode)\(/, kind: 'auth', text: (m) => `JWT ${m[1]}` },
  { re: /session\(\)->(set|get|remove|destroy|setFlashdata|getFlashdata|has|flash|put|forget|regenerate|push)\(\s*['"]?([\w.\-]*)/, kind: 'session', text: (m) => `Session ${m[1]}${m[2] ? ` '${m[2]}'` : ''}` },
  { re: /\$this->session->(\w+)\(\s*['"]?([\w.\-]*)/, kind: 'session', text: (m) => `Session ${m[1]}${m[2] ? ` '${m[2]}'` : ''}` },
  { re: /\$_SESSION\[\s*['"]([\w\-]+)['"]/, kind: 'session', text: (m) => `Uses $_SESSION['${m[1]}']` },
  { re: /\bsession_(start|destroy|regenerate_id)\(/, kind: 'session', text: (m) => `session_${m[1]}()` },
  { re: /->(transStart|transBegin|beginTransaction|transComplete|transCommit|commit|rollback|transRollback)\(|DB::transaction\(/, kind: 'db', text: (m) => `Transaction ${m[1] || 'block'}` },
  { re: /redirect\(\)->to\(\s*([^)]*)\)/, kind: 'redirect', text: (m) => `Redirects to ${urlText(m[1])}`, response: 'redirect' },
  { re: /redirect\(\)->(?:route|toRoute)\(\s*['"]([^'"]+)['"]/, kind: 'redirect', text: (m) => `Redirects to route '${m[1]}'`, response: 'redirect' },
  { re: /redirect\(\)->back\(|back\(\)->with|return\s+back\(\)/, kind: 'redirect', text: () => 'Redirects back', response: 'redirect' },
  { re: /redirect\(\)->(?:intended|away|action|guest)\(/, kind: 'redirect', text: () => 'Redirects', response: 'redirect' },
  { re: /\bredirect\(\s*['"]([^'"]+)['"]/, kind: 'redirect', text: (m) => `Redirects to ${m[1]}`, response: 'redirect' },
  { re: /\bheader\(\s*['"]Location:\s*([^'"]*)/i, kind: 'redirect', text: (m) => `Redirects to ${m[1] || '(computed URL)'}`, response: 'redirect' },
  { re: /->with\(\s*['"](success|error|message|status|warning|info|errors?|msg)['"]/, kind: 'session', text: (m) => `Sets flash message '${m[1]}'` },
  { re: /->setJSON\(|response\(\)->json\(|Response::json\(|->respond(?:Created|Deleted|Updated)?\(|->fail\w*\(/, kind: 'response', text: () => 'Returns JSON', response: 'json' },
  { re: /\becho\s+json_encode\(|\bjson_encode\(.*\)\s*;?\s*$/, kind: 'response', text: () => 'Outputs JSON', response: 'json' },
  { re: /->download\(|response\(\)->(?:download|file|streamDownload)\(|readfile\(|fpassthru\(/, kind: 'response', text: () => 'Sends a file download', response: 'file' },
  { re: /->setContentType\(\s*['"]([^'"]+)['"]|header\(\s*['"]Content-Type:\s*([^'";]+)/i, kind: 'response', text: (m) => `Sets Content-Type ${m[1] || m[2]}` },
  { re: /->setStatusCode\(\s*(\d+)/, kind: 'response', text: (m) => `Sets HTTP status ${m[1]}` },
  { re: /\bfputcsv\(/, kind: 'response', text: () => 'Writes CSV output', response: 'file' },
  { re: /PageNotFoundException::forPageNotFound\(|\babort\(\s*404|throw new NotFoundHttpException/, kind: 'error', text: () => 'Responds 404 Not Found', response: 'error' },
  { re: /\babort\(\s*(\d{3})/, kind: 'error', text: (m) => `Aborts with HTTP ${m[1]}`, response: 'error' },
  { re: /\bthrow\s+new\s+\\?([\w\\]+)/, kind: 'error', text: (m) => `Throws ${m[1].split('\\').pop()}` },
  { re: /\bcurl_(init|exec)\(/, kind: 'external', text: () => 'Calls an external HTTP API (cURL)' },
  { re: /\bHttp::(get|post|put|patch|delete|withToken|withHeaders|asForm|acceptJson)\(/, kind: 'external', text: () => 'Calls an external HTTP API (Http client)' },
  { re: /Services::curlrequest\(|new\s+\\?(?:GuzzleHttp\\)?Client\(|->request\(\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/, kind: 'external', text: () => 'Calls an external HTTP API' },
  { re: /file_get_contents\(\s*['"]https?:/, kind: 'external', text: () => 'Fetches a remote URL' },
  { re: /Services::email\(|\bMail::(to|send|queue|raw)\(|\bmail\(\s*\$|new\s+PHPMailer|->sendMail\(/, kind: 'mail', text: () => 'Sends an email' },
  { re: /->move\(\s*([^,)]+)/, kind: 'file', text: (m) => `Moves an uploaded file to ${squash(m[1], 50)}` },
  { re: /->(?:store|storeAs|storePublicly)\(|Storage::(put|delete|disk|putFile)/, kind: 'file', text: () => 'Stores a file' },
  { re: /\bunlink\(|\bFile::delete\(/, kind: 'file', text: () => 'Deletes a file from disk' },
  { re: /\b(file_put_contents|fopen|mkdir|copy|rename)\(/, kind: 'file', text: (m) => `File system ${m[1]}()` },
  { re: /\blog_message\(\s*['"](\w+)['"]|\bLog::(\w+)\(|\blogger\(|\berror_log\(/, kind: 'log', text: (m) => `Writes a log entry${m[1] || m[2] ? ` (${m[1] || m[2]})` : ''}` },
  { re: /\bcache\(\)->(\w+)|\bCache::(\w+)\(|\$this->cache->(\w+)|\bcache\(\s*['"]/, kind: 'cache', text: (m) => `Cache ${m[1] || m[2] || m[3] || 'read'}` },
  { re: /\bdispatch\(|::dispatch\(|Queue::push|->queue\(/, kind: 'queue', text: () => 'Queues a background job' },
  { re: /\bevent\(\s*new|Events::trigger\(\s*['"](\w+)|Event::dispatch\(/, kind: 'event', text: (m) => `Fires event${m[1] ? ` '${m[1]}'` : ''}` },
  { re: /\bhelper\(\s*\[?([^)]*)\]?\s*\)/, kind: 'call', text: (m) => `Loads helper(s) ${m[1].replace(/['"\[\]\s]/g, '')}` },
];

const COMMON_PY: Rule[] = [
  { re: /request\.method\s*==/, kind: 'branch', text: () => 'Branches on the HTTP method' },
  { re: /request\.(POST|GET|data|form|args|values|query_params)\.get\(\s*['"]([\w\-]+)['"]|request\.(POST|GET|data|form|args|query_params)\[\s*['"]([\w\-]+)['"]/, kind: 'input', text: (m) => `Reads request.${m[1] || m[3]}['${m[2] || m[4]}']` },
  { re: /request\.(FILES|files)\b/, kind: 'input', text: () => 'Reads uploaded files' },
  { re: /request\.(get_json|json)\b|await\s+request\.json\(\)/, kind: 'input', text: () => 'Reads the JSON request body' },
  { re: /\w*Form\(\s*request\.(POST|data)/, kind: 'validate', text: () => 'Binds a form to submitted data' },
  { re: /\.is_valid\(|\.validate\(|\.model_validate\(|\.parse_obj\(/, kind: 'validate', text: () => 'Validates input' },
  { re: /\b(authenticate|login|logout)\(\s*request/, kind: 'auth', text: (m) => `Auth ${m[1]}()` },
  { re: /\b(check_password|make_password|set_password|verify_password|get_password_hash)\(/, kind: 'auth', text: (m) => `${m[1]}()` },
  { re: /\bjwt\.(encode|decode)\(/, kind: 'auth', text: (m) => `JWT ${m[1]}` },
  { re: /request\.user\.(is_authenticated|is_staff|is_superuser|has_perm)/, kind: 'auth', text: (m) => `Checks request.user.${m[1]}` },
  { re: /request\.session\[\s*['"]([\w\-]+)['"]|request\.session\.(get|pop|flush|clear)\(/, kind: 'session', text: (m) => `Session ${m[2] || ''} '${m[1] || ''}'`.replace(" ''", '') },
  { re: /(?:^|[^.\w])session\[\s*['"]([\w\-]+)['"]/, kind: 'session', text: (m) => `Session '${m[1]}'` },
  { re: /\bmessages\.(success|error|info|warning|add_message)\(/, kind: 'session', text: (m) => `Adds a flash message (${m[1]})` },
  { re: /\bflash\(/, kind: 'session', text: () => 'Adds a flash message' },
  { re: /transaction\.atomic|\.commit\(\)|\.rollback\(\)|\.begin\(\)/, kind: 'db', text: () => 'Transaction boundary' },
  { re: /\b(?:HttpResponseRedirect|RedirectResponse|redirect)\(\s*([^)]*)\)/, kind: 'redirect', text: (m) => `Redirects to ${urlText(m[1])}`, response: 'redirect' },
  { re: /\b(?:JsonResponse|jsonify|ORJSONResponse|JSONResponse)\(/, kind: 'response', text: () => 'Returns JSON', response: 'json' },
  { re: /\breturn\s+Response\(/, kind: 'response', text: () => 'Returns an API response', response: 'json' },
  { re: /\b(?:FileResponse|StreamingResponse|send_file|send_from_directory)\(/, kind: 'response', text: () => 'Sends a file', response: 'file' },
  { re: /\bHttpResponse\(/, kind: 'response', text: () => 'Returns a raw HTTP response', response: 'text' },
  { re: /\breturn\s+\{/, kind: 'response', text: () => 'Returns a JSON object', response: 'json' },
  { re: /\braise\s+Http404|get_object_or_404\(|\babort\(\s*404|status_code\s*=\s*404/, kind: 'error', text: () => 'Responds 404 Not Found when missing', response: 'error' },
  { re: /\braise\s+HTTPException\([^)]*status_code\s*=\s*(?:status\.HTTP_)?(\d{3})/, kind: 'error', text: (m) => `Raises HTTP ${m[1]}` },
  { re: /\braise\s+(\w+)/, kind: 'error', text: (m) => `Raises ${m[1]}` },
  { re: /\babort\(\s*(\d{3})/, kind: 'error', text: (m) => `Aborts with HTTP ${m[1]}` },
  { re: /\b(requests|httpx|aiohttp|urllib\.request)\.(get|post|put|patch|delete|request|urlopen|AsyncClient|Client|ClientSession)\b/, kind: 'external', text: (m) => `Calls an external HTTP API (${m[1]})` },
  { re: /\bboto3\.(client|resource)\(\s*['"](\w+)['"]/, kind: 'external', text: (m) => `Uses AWS ${m[2]}` },
  { re: /\b(send_mail|send_mass_mail|EmailMessage|EmailMultiAlternatives|mail\.send)\(/, kind: 'mail', text: () => 'Sends an email' },
  { re: /\bdefault_storage\.|\bfs\.save\(|\.chunks\(\)|\bos\.remove\(|\bshutil\./, kind: 'file', text: () => 'Reads or writes files' },
  { re: /\blogger\.(debug|info|warning|error|exception|critical)\(|\blogging\.(info|warning|error|exception)\(/, kind: 'log', text: (m) => `Writes a log entry (${m[1] || m[2]})` },
  { re: /\bcache\.(get|set|delete|get_or_set)\(/, kind: 'cache', text: (m) => `Cache ${m[1]}` },
  { re: /\.(delay|apply_async)\(|background_tasks\.add_task\(|BackgroundTasks|\.enqueue\(/, kind: 'queue', text: () => 'Queues a background task' },
  { re: /\b(?:signals?\.\w+\.send|\.send_robust)\(/, kind: 'event', text: () => 'Sends a signal' },
];

const COMMON_JS: Rule[] = [
  { re: /req\.body\.(\w+)|const\s*\{([^}]*)\}\s*=\s*req\.body/, kind: 'input', text: (m) => `Reads body field${m[2] ? 's ' + squash(m[2], 50) : ` '${m[1]}'`}` },
  { re: /req\.body\b/, kind: 'input', text: () => 'Reads the request body' },
  { re: /req\.params\.(\w+)|const\s*\{([^}]*)\}\s*=\s*req\.params/, kind: 'input', text: (m) => `Reads URL param${m[2] ? 's ' + squash(m[2], 50) : ` '${m[1]}'`}` },
  { re: /req\.query\.(\w+)|const\s*\{([^}]*)\}\s*=\s*req\.query/, kind: 'input', text: (m) => `Reads query param${m[2] ? 's ' + squash(m[2], 50) : ` '${m[1]}'`}` },
  { re: /req\.(files?)\b/, kind: 'input', text: () => 'Reads uploaded file(s)' },
  { re: /req\.(?:headers|get\()|req\.cookies/, kind: 'input', text: () => 'Reads headers or cookies' },
  { re: /validationResult\(|\.validate\(|\.safeParse\(|\.parse\(\s*req\.|Joi\.|\.validateAsync\(/, kind: 'validate', text: () => 'Validates input' },
  { re: /\bjwt\.(sign|verify|decode)\(/, kind: 'auth', text: (m) => `JWT ${m[1]}` },
  { re: /\bbcrypt\w*\.(compare|hash)\w*\(|argon2\.(verify|hash)\(/, kind: 'auth', text: () => 'Hashes or verifies a password' },
  { re: /passport\.authenticate\(|req\.(?:isAuthenticated|login|logout)\(/, kind: 'auth', text: () => 'Authenticates the user' },
  { re: /req\.session\.(\w+)/, kind: 'session', text: (m) => `Session '${m[1]}'` },
  { re: /req\.flash\(/, kind: 'session', text: () => 'Sets a flash message' },
  { re: /\$transaction\(|\.transaction\(|startSession\(/, kind: 'db', text: () => 'Transaction boundary' },
  { re: /res\.redirect\(\s*(?:\d+\s*,\s*)?([^)]*)\)/, kind: 'redirect', text: (m) => `Redirects to ${urlText(m[1])}`, response: 'redirect' },
  { re: /res(?:\.status\(\s*\d+\s*\))?\.json\(/, kind: 'response', text: () => 'Returns JSON', response: 'json' },
  { re: /res(?:\.status\(\s*\d+\s*\))?\.(?:sendFile|download|attachment)\(/, kind: 'response', text: () => 'Sends a file', response: 'file' },
  { re: /res(?:\.status\(\s*\d+\s*\))?\.send\(/, kind: 'response', text: () => 'Sends a response', response: 'text' },
  { re: /res(?:\.status\(\s*\d+\s*\))?\.end\(/, kind: 'response', text: () => 'Ends the response', response: 'text' },
  { re: /res\.(?:status|sendStatus)\(\s*(\d{3})/, kind: 'response', text: (m) => `Sets HTTP status ${m[1]}` },
  { re: /return\s+(?:Response|NextResponse)\.json\(/, kind: 'response', text: () => 'Returns JSON', response: 'json' },
  { re: /\bnext\(\s*(?:err|error|e|new\s+\w+)/, kind: 'error', text: () => 'Passes an error to the error handler' },
  { re: /\bthrow\s+(?:new\s+)?(\w+)/, kind: 'error', text: (m) => `Throws ${m[1]}` },
  { re: /\baxios(?:\.(get|post|put|patch|delete|request))?\(|\bfetch\(\s*[`'"]https?:|\bgot(?:\.\w+)?\(|\bsuperagent\./, kind: 'external', text: () => 'Calls an external HTTP API' },
  { re: /\.sendMail\(|sgMail\.send\(|resend\.emails\.send\(|mailgun|ses\.send/, kind: 'mail', text: () => 'Sends an email' },
  { re: /\bfs(?:\.promises)?\.(readFile|writeFile|unlink|rename|mkdir|createReadStream|createWriteStream)\w*\(/, kind: 'file', text: (m) => `File system ${m[1]}()` },
  { re: /\blogger\.(info|warn|error|debug)\(/, kind: 'log', text: (m) => `Writes a log entry (${m[1]})` },
  { re: /\b(?:redis|cache|client)\.(get|set|setex|del|hget|hset|expire)\(/, kind: 'cache', text: (m) => `Cache ${m[1]}` },
  { re: /\b\w*[qQ]ueue\.add\(|\.publish\(|\.sendToQueue\(/, kind: 'queue', text: () => 'Queues a background job' },
  { re: /\.emit\(\s*['"]([\w:.\-]+)['"]/, kind: 'event', text: (m) => `Emits event '${m[1]}'` },
];

function urlText(arg: string): string {
  const a = arg.trim();
  const s = unquote(splitTopLevel(a)[0]);
  if (s !== null) return s || '/';
  const inner = /['"]([^'"]+)['"]/.exec(a);
  return inner ? inner[1] : squash(a, 50) || '(computed URL)';
}

/** Statements of a Python body: its logical lines. */
function pyStatements(body: Array<{ text: string; line: number }>): Statement[] {
  return body.map((l) => ({ text: l.text, line: l.line }));
}

export function analyzeBody(
  body: string | Array<{ text: string; line: number }>,
  lineOf: (offset: number) => number,
  ctx: StepContext,
): BodyAnalysis {
  const res: BodyAnalysis = { steps: [], data: [], views: [], responses: [], models: [], tables: [], redirects: [] };
  const stmts = typeof body === 'string'
    ? braceStatements(body, lineOf, ctx.lang === 'php' ? `'"` : `'"\``)
    : pyStatements(body);
  const rules = ctx.lang === 'php' ? COMMON_PHP : ctx.lang === 'python' ? COMMON_PY : COMMON_JS;
  const fullText = typeof body === 'string' ? body : body.map((b) => b.text).join('\n');
  const seen = new Set<string>();
  const push = (s: Step) => {
    const key = `${s.kind}|${s.text}|${s.line}`;
    if (seen.has(key) || res.steps.length >= MAX_STEPS) return;
    seen.add(key);
    res.steps.push(s);
  };
  const addData = (d: DataAccess, code: string) => {
    if (!res.data.some((x) => x.model === d.model && x.table === d.table && x.op === d.op && x.line === d.line)) res.data.push(d);
    if (d.model && !res.models.includes(d.model)) res.models.push(d.model);
    if (d.table && !res.tables.includes(d.table)) res.tables.push(d.table);
    const target = d.model ? `${d.model}${d.table ? ` → ${d.table}` : ''}` : d.table;
    push({ kind: 'db', line: d.line, text: `${OP_LABEL[d.op]} ${target}`, code: squash(code, 110) });
  };

  for (const st of stmts) {
    const t = st.text;
    if (!t || t === '{' || t === '}') continue;
    const before = res.steps.length;
    if (ctx.lang === 'php') phpData(t, st.line, ctx, addData, push);
    else if (ctx.lang === 'python') pyData(t, st.line, ctx, addData, push);
    else jsData(t, st.line, ctx, addData, push);
    viewCalls(t, st.line, ctx, fullText, res, push);
    for (const r of rules) {
      const m = r.re.exec(t);
      if (!m) continue;
      if (r.kind === 'error' && res.steps.some((s) => s.line === st.line && s.kind === 'error')) continue;
      push({ kind: r.kind, line: st.line, text: r.text(m), code: res.steps.length === before ? squash(t, 110) : undefined });
      if (r.response && !res.responses.includes(r.response)) res.responses.push(r.response);
      if (r.kind === 'redirect') res.redirects.push(r.text(m).replace(/^Redirects to /, ''));
    }
    if (ctx.siblings && ctx.siblings.size) {
      const callRe = ctx.lang === 'php' ? /\$this->(\w+)\(/g : ctx.lang === 'python' ? /\bself\.(\w+)\(/g : /\bthis\.(\w+)\(/g;
      for (const cm of t.matchAll(callRe)) {
        if (ctx.siblings.has(cm[1])) push({ kind: 'call', line: st.line, text: `Calls ${cm[1]}()` });
      }
    }
  }
  res.steps.sort((a, b) => a.line - b.line);
  return res;
}

type AddData = (d: DataAccess, code: string) => void;
type Push = (s: Step) => void;

function sqlFromStatement(t: string, line: number, add: AddData) {
  for (const sm of t.matchAll(/(['"`])((?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b[\s\S]*?)\1/gi)) {
    for (const ref of sqlTableRefs(sm[2])) add({ table: ref.table, op: ref.op, line }, sm[2]);
  }
}

function phpData(t: string, line: number, ctx: StepContext, add: AddData, push: Push) {
  // new FooModel() / model('FooModel') / model(Foo::class)
  for (const m of t.matchAll(/new\s+\\?([\w\\]+)\s*\(|\bmodel\(\s*['"]?\\?([\w\\]+?)(?:::class)?['"]?\s*[,)]/g)) {
    const name = ctx.resolveModel((m[1] || m[2]).split('\\').pop()!);
    if (name) push({ kind: 'model', line, text: `Creates ${name}` });
  }
  // receiver chains: $this->fooModel->where()->findAll(), $foo->save(), Foo::where()->get()
  const CHAIN = /(\$this->\w+|\$\w+|\b[A-Z]\w*)\s*(->|::)\s*\w+\s*\(/g;
  let m: RegExpExecArray | null;
  const used = new Set<number>();
  while ((m = CHAIN.exec(t))) {
    if (used.has(m.index)) continue;
    const recv = m[1];
    if (/^\$this->(request|response|session|validator|validation|db)$/.test(recv) || recv === '$request') continue;
    const model = ctx.resolveModel(recv);
    if (!model) continue;
    const chain = readChain(t, m.index + recv.length);
    used.add(m.index);
    CHAIN.lastIndex = m.index + recv.length + chain.length;
    add({ model, table: ctx.modelTable(model), op: opOfChain(chain), line }, recv + chain);
  }
  // Query Builder / DB facade: ->table('x'), DB::table('x'), db_connect()->table('x')
  for (const tm of t.matchAll(/(?:->|::)table\(\s*['"](\w+)['"]\s*\)/g)) {
    const chain = readChain(t, tm.index! + tm[0].length);
    add({ table: tm[1], op: opOfChain(chain) === 'access' ? 'read' : opOfChain(chain), line }, tm[0] + chain);
  }
  if (/->query\(|DB::(select|insert|update|delete|statement|unprepared)\(|mysqli_query\(|->prepare\(|->exec\(|->simpleQuery\(/.test(t)) sqlFromStatement(t, line, add);
}

function pyData(t: string, line: number, ctx: StepContext, add: AddData, push: Push) {
  let m: RegExpExecArray | null;
  const OBJ = /\b([A-Z]\w*)\.(objects|query)\b/g;
  while ((m = OBJ.exec(t))) {
    const model = ctx.resolveModel(m[1]);
    if (!model) continue;
    const chain = readChain(t, m.index + m[1].length);
    add({ model, table: ctx.modelTable(model), op: opOfChain(chain), line }, m[0] + chain);
  }
  const GET404 = /\bget_object_or_404\(\s*([A-Z]\w*)|\bget_list_or_404\(\s*([A-Z]\w*)/g;
  while ((m = GET404.exec(t))) {
    const model = ctx.resolveModel(m[1] || m[2]);
    if (model) add({ model, table: ctx.modelTable(model), op: 'read', line }, m[0]);
  }
  const SA = /\b(?:query|select|update|delete|insert)\(\s*([A-Z]\w*)/g;
  while ((m = SA.exec(t))) {
    const model = ctx.resolveModel(m[1]);
    if (!model) continue;
    const verb = /^(\w+)/.exec(m[0])![1];
    const op: DataOp = verb === 'delete' ? 'delete' : verb === 'update' || verb === 'insert' ? 'write' : opOfChain(readChain(t, m.index + m[0].length)) === 'delete' ? 'delete' : 'read';
    add({ model, table: ctx.modelTable(model), op, line }, squash(t, 100));
  }
  // obj = Model(...); db.add(obj) / obj.save()
  const CTOR = /\b([A-Z]\w*)\s*\(/g;
  if (/\.(add|save|add_all|create)\(|\bawait\s+\w+\.(insert|save)\(/.test(t) || /=\s*[A-Z]\w*\(/.test(t)) {
    while ((m = CTOR.exec(t))) {
      const model = ctx.resolveModel(m[1]);
      if (model && /=\s*$/.test(t.slice(0, m.index))) {
        push({ kind: 'model', line, text: `Builds a ${model} instance` });
        add({ model, table: ctx.modelTable(model), op: 'write', line }, t);
      }
    }
  }
  if (/\.(add|add_all)\(/.test(t)) push({ kind: 'db', line, text: 'Adds object(s) to the DB session (WRITE)', code: squash(t, 110) });
  if (/\b(cursor\.execute|execute|text|raw)\(/.test(t)) sqlFromStatement(t, line, add);
}

function jsData(t: string, line: number, ctx: StepContext, add: AddData, _push: Push) {
  let m: RegExpExecArray | null;
  const RECV = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\.\s*(\w+)\s*\(/g;
  const used = new Set<number>();
  while ((m = RECV.exec(t))) {
    if (used.has(m.index)) continue;
    const recv = m[1];
    if (/^(req|res|console|JSON|Math|Object|Array|Promise|router|app|this|axios|fs|path|jwt|bcrypt)$/.test(recv.split('.')[0])) continue;
    const model = ctx.resolveModel(recv);
    if (!model) continue;
    const chain = readChain(t, m.index + recv.length);
    used.add(m.index);
    const op = opOfChain(chain);
    if (op === 'access') continue;
    add({ model, table: ctx.modelTable(model), op, line }, recv + chain);
    RECV.lastIndex = m.index + recv.length + chain.length;
  }
  for (const km of t.matchAll(/\b(?:knex|db|trx)\(\s*['"](\w+)['"]\s*\)|\.(?:from|table|into)\(\s*['"](\w+)['"]\s*\)/g)) {
    const chain = readChain(t, km.index! + km[0].length);
    const op = opOfChain(chain);
    add({ table: km[1] || km[2], op: op === 'access' ? 'read' : op, line }, km[0] + chain);
  }
  if (/\.(query|execute|raw|\$queryRaw|\$executeRaw)\s*[(`]/.test(t)) sqlFromStatement(t, line, add);
}

/** Reads "->a(...)->b(...)" / ".a(...).b(...)" starting at `from`. */
function readChain(t: string, from: number): string {
  let i = from;
  let out = '';
  for (;;) {
    const m = /^\s*(->|::|\.)\s*(\w+)\s*(\()?/.exec(t.slice(i));
    if (!m) break;
    if (!m[3]) {
      // property hop (".objects", "->db") — keep going
      out += t.slice(i, i + m[0].length);
      i += m[0].length;
      continue;
    }
    const open = i + m[0].length - 1;
    const close = matchBracket(t, open);
    if (close < 0) break;
    out += t.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

function viewCalls(t: string, line: number, ctx: StepContext, full: string, res: BodyAnalysis, push: Push) {
  const add = (name: string, vars: string[]) => {
    res.views.push({ name, vars: uniq(vars).slice(0, 60), line });
    if (!res.responses.includes('html')) res.responses.push('html');
    push({ kind: 'view', line, text: `Renders view ${name}`, code: vars.length ? `vars: ${uniq(vars).slice(0, 12).join(', ')}` : undefined });
  };
  if (ctx.lang === 'php') {
    for (const m of t.matchAll(/(?:^|[^\w>:$])(?:view|View::make)\(\s*(['"])([^'"]+)\1/g)) {
      const open = m.index! + m[0].indexOf('(');
      const close = matchBracket(t, open, `'"`);
      const args = splitTopLevel(t.slice(open + 1, close < 0 ? t.length : close), ',', `'"`);
      let vars = phpVars(args[1], full);
      const withs = Array.from(t.slice(close + 1).matchAll(/->with\(\s*['"](\w+)['"]|->with([A-Z]\w*)\(/g)).map((w) => w[1] || w[2][0].toLowerCase() + w[2].slice(1));
      vars = vars.concat(withs);
      const withArr = /->with\(\s*(\[[\s\S]*?\])\s*\)/.exec(t.slice(close + 1));
      if (withArr) vars = vars.concat(arrayKeys(withArr[1]));
      add(m[2], vars);
    }
    for (const m of t.matchAll(/\$this->(?:load->view|render|view)\(\s*['"]([^'"]+)['"]/g)) add(m[1], []);
    for (const m of t.matchAll(/\b(?:include|require)(?:_once)?\s*\(?\s*[^;]*?['"]([^'"]+\.(?:php|phtml|html))['"]/g)) {
      if (/view|template|partial|layout|header|footer|page/i.test(m[1])) add(m[1], []);
    }
  } else if (ctx.lang === 'python') {
    let m = /\b(?:render|render_to_response|TemplateResponse|render_template|templates\.TemplateResponse)\(\s*(?:request\s*,\s*)?(?:name\s*=\s*)?(['"])([^'"]+)\1([\s\S]*)$/.exec(t);
    if (m) {
      const rest = m[3];
      let vars: string[] = [];
      const dict = /\{([\s\S]*?)\}/.exec(rest);
      if (dict) vars = Array.from(dict[1].matchAll(/['"](\w+)['"]\s*:/g)).map((x) => x[1]);
      vars = vars.concat(Array.from(rest.matchAll(/(?:^|[,(]\s*)(\w+)\s*=(?!=)/g)).map((x) => x[1]).filter((v) => v !== 'context' && v !== 'status_code'));
      const ctxVar = /,\s*(?:context\s*=\s*)?(\w+)\s*\)?\s*$/.exec(rest.replace(/\)\s*$/, ')'));
      if (ctxVar && !dict) {
        const assigned = Array.from(full.matchAll(new RegExp(`\\b${ctxVar[1]}\\[\\s*['"](\\w+)['"]\\s*\\]\\s*=|\\b${ctxVar[1]}\\s*=\\s*\\{([^}]*)\\}`, 'g')));
        for (const a of assigned) {
          if (a[1]) vars.push(a[1]);
          if (a[2]) vars = vars.concat(Array.from(a[2].matchAll(/['"](\w+)['"]\s*:/g)).map((x) => x[1]));
        }
      }
      add(m[2], vars);
    }
  } else {
    const m = /\bres\.render\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*\{([\s\S]*)\})?/.exec(t);
    if (m) {
      const vars = m[3] ? splitTopLevel(m[3]).map((p) => (/^\.\.\./.test(p) ? '' : /^([\w$]+)/.exec(p)?.[1] || '')).filter(Boolean) : [];
      add(m[2], vars);
    }
  }
}

function phpVars(arg: string | undefined, full: string): string[] {
  if (!arg) return [];
  const a = arg.trim();
  if (a.startsWith('[') || /^array\s*\(/i.test(a)) return arrayKeys(a);
  const compact = /^compact\(([^)]*)\)/.exec(a);
  if (compact) return Array.from(compact[1].matchAll(/['"](\w+)['"]/g)).map((m) => m[1]);
  const v = /^\$(\w+)$/.exec(a);
  if (v) {
    const keys = Array.from(full.matchAll(new RegExp(`\\$${v[1]}\\[\\s*['"](\\w+)['"]\\s*\\]\\s*=`, 'g'))).map((m) => m[1]);
    for (const lit of full.matchAll(new RegExp(`\\$${v[1]}\\s*=\\s*(\\[|array\\s*\\()`, 'g'))) {
      const open = lit.index! + lit[0].length - 1;
      const close = matchBracket(full, open, `'"`);
      if (close > 0) keys.push(...arrayKeys(full.slice(lit.index! + lit[0].length - lit[1].length, close + 1)));
    }
    for (const am of full.matchAll(new RegExp(`\\$${v[1]}\\s*=\\s*array_merge\\(([^;]*)\\)`, 'g'))) keys.push(...arrayKeys(am[1].split(/,\s*(?=\[)/).pop() || ''));
    return uniq(keys);
  }
  return [];
}

/** Collects `$this->prop = new XModel()` / `model('X')` assignments into an alias map. */
export function phpModelAliases(classText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of classText.matchAll(/\$this->(\w+)\s*=\s*(?:new\s+\\?([\w\\]+)\s*\(|model\(\s*['"]?\\?([\w\\]+?)(?:::class)?['"]?\s*[,)])/g)) {
    out.set(m[1], (m[2] || m[3]).split('\\').pop()!);
  }
  for (const m of classText.matchAll(/(?:private|protected|public)\s+(?:readonly\s+)?\??\\?([\w\\]+)\s+\$(\w+)/g)) {
    if (!out.has(m[2])) out.set(m[2], m[1].split('\\').pop()!);
  }
  return out;
}
