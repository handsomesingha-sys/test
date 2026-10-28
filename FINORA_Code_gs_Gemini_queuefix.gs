/**
• LINE AI CHATBOT MANAGEMENT SYSTEM
• Backend: Google Apps Script
• Database: Google Sheets
• Frontend: GitHub Pages
• API Gateway: Cloudflare Worker
• VERSION: 3.0.0
• REQUIRED SCRIPT PROPERTIES:
• WORKER_SHARED_SECRET
• GEMINI_API_KEY
• GEMINI_MODEL
• LINE_CHANNEL_ACCESS_TOKEN (optional fallback channel)
• Handover loading refresh trigger runs every minute while queue items remain open
• SPREADSHEET_ID (auto-created by setupSystem)
• SECURITY:
◦ Never put any secrets in GitHub Pages or a public repository.
◦ All POST requests require WORKER_SHARED_SECRET.
◦ The Cloudflare Worker must verify LINE X-Line-Signature before
• forwarding LINE webhook requests to this script.
◦ A shared secret between Worker and Apps Script is not a substitute
• for access control on the public Worker. Protect admin actions too.
*/

const APP = Object.freeze({
NAME: 'LINE AI Chatbot Management System',
VERSION: '3.0.0',
TIMEZONE: 'Asia/Bangkok',
GEMINI_BASE_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/',
DEFAULT_GEMINI_MODEL: 'gemini-3.5-flash-lite',
LINE_ENDPOINT: 'https://api.line.me',
LINE_DATA_ENDPOINT: 'https://api-data.line.me',
MAX_TEXT_LENGTH: 4500,
MAX_LIST_ROWS: 5000,
MAX_CONVERSATION_ROWS: 300,
MAX_MULTICAST_USERS: 500,
DEFAULT_AI_TOKENS: 800
});

const TABLE_SCHEMAS = Object.freeze({
Settings: [
'id', 'key', 'value', 'description', 'updatedAt'
 ],
Friends: [
'id', 'userId', 'displayName', 'pictureUrl', 'statusMessage',
'language', 'status', 'tags', 'aiEnabled', 'notes', 'assignedTo',
'lastMessage', 'lastMessageAt', 'lastSeenAt', 'createdAt', 'updatedAt'
 ],
ChatSessions: [
'id', 'userId', 'displayName', 'status', 'assignedTo',
'lastMessage', 'lastMessageAt', 'unreadCount', 'aiEnabled',
'tags', 'createdAt', 'updatedAt'
 ],
ChatLogs: [
'id', 'timestamp', 'userId', 'displayName', 'direction',
'messageType', 'text', 'messageJson', 'source', 'status',
'campaignId', 'channelId'
 ],
Prompts: [
'id', 'name', 'content', 'active', 'version',
'description', 'createdAt', 'updatedAt'
 ],
PromptVersions: [
'id', 'promptId', 'promptName', 'version',
'content', 'note', 'createdAt', 'createdBy'
 ],
KnowledgeBase: [
'id', 'title', 'content', 'keywords', 'category',
'enabled', 'priority', 'source', 'createdAt', 'updatedAt'
 ],
Documents: [
'id', 'title', 'content', 'source', 'mimeType',
'status', 'metadata', 'createdAt', 'updatedAt'
 ],
FlexTemplates: [
'id', 'name', 'description', 'altText', 'contents',
'category', 'enabled', 'createdAt', 'updatedAt'
 ],
WelcomeFlow: [
'id', 'name', 'triggerType', 'keyword', 'messageType',
'text', 'messageJson', 'enabled', 'priority',
'createdAt', 'updatedAt'
 ],
AutomationRules: [
'id', 'name', 'triggerType', 'keyword', 'actionType',
'actionValue', 'enabled', 'priority', 'description',
'createdAt', 'updatedAt'
 ],
Campaigns: [
'id', 'name', 'type', 'status', 'scheduledAt', 'channelId',
'targetType', 'targetTags', 'selectedUserIds', 'messageType',
'text', 'messageJson', 'sentCount', 'totalRecipients',
'lastError', 'createdAt', 'updatedAt'
 ],
BroadcastLogs: [
'id', 'campaignId', 'campaignName', 'timestamp',
'recipientCount', 'status', 'details', 'error'
 ],
AIProfiles: [
'id', 'name', 'description', 'model', 'systemPrompt',
'temperature', 'maxOutputTokens', 'enabled',
'createdAt', 'updatedAt'
 ],
Channels: [
'id', 'name', 'channelId', 'tokenProperty',
'enabled', 'isDefault', 'description',
'createdAt', 'updatedAt'
 ],
RichMenus: [
'id', 'name', 'richMenuId', 'altText', 'selected',
'chatBarText', 'menuJson', 'imageUploaded', 'enabled',
'createdAt', 'updatedAt'
 ],
SafetyRules: [
'id', 'name', 'ruleType', 'value', 'enabled',
'description', 'createdAt', 'updatedAt'
 ],
HandoverQueue: [
'id', 'userId', 'displayName', 'reason', 'status',
'assignedTo', 'createdAt', 'updatedAt', 'closedAt'
 ],
ScheduledJobs: [
'id', 'name', 'jobType', 'status', 'runAt',
'payload', 'attempts', 'lastError', 'createdAt', 'updatedAt'
 ],
UsageStats: [
'id', 'date', 'metric', 'value', 'metadata', 'createdAt'
 ],
WebhookEvents: [
'id', 'timestamp', 'eventType', 'userId',
'webhookEventId', 'status', 'payload', 'error'
 ],
AdminLogs: [
'id', 'timestamp', 'action', 'tableName',
'recordId', 'details', 'result'
 ],
SystemLogs: [
'id', 'timestamp', 'level', 'source', 'message', 'details'
 ]
});

const FRONTEND_TABLES = Object.freeze(Object.keys(TABLE_SCHEMAS));

const READ_ONLY_TABLES = Object.freeze([
'ChatLogs',
'BroadcastLogs',
'UsageStats',
'WebhookEvents',
'AdminLogs',
'SystemLogs'
]);

const LOG_EXCLUDED_TABLES = Object.freeze([
'AdminLogs',
'SystemLogs',
'ChatLogs',
'WebhookEvents',
'UsageStats'
]);

const DEFAULT_SETTINGS = Object.freeze([
{
key: 'bot_name',
value: 'LINE AI Assistant',
description: 'ชื่อบอต'
},
{
key: 'ai_enabled',
value: 'true',
description: 'เปิดใช้งาน AI'
},
{
key: 'welcome_enabled',
value: 'true',
description: 'เปิดข้อความต้อนรับ'
},
{
key: 'knowledge_enabled',
value: 'true',
description: 'เปิด Knowledge Base'
},
{
key: 'default_prompt_name',
value: 'default',
description: 'ชื่อ Prompt เริ่มต้น'
},
{
key: 'default_ai_profile',
value: '',
description: 'ID ของ AI Profile เริ่มต้น'
},
{
key: 'default_channel_id',
value: '',
description: 'ID ของ LINE Channel เริ่มต้น'
},
{
key: 'safety_blocked_terms',
value: '',
description: 'คำที่ระบบไม่ควรสร้างในคำตอบ'
},
{
key: 'safety_max_reply_chars',
value: '4000',
description: 'ความยาวข้อความตอบกลับสูงสุด'
},
{
key: 'auto_handover_keywords',
value: 'เจ้าหน้าที่,แอดมิน,พนักงาน',
description: 'คำที่ใช้ขอคุยกับเจ้าหน้าที่'
},
{
key: 'campaign_batch_size',
value: '300',
description: 'จำนวนผู้รับแคมเปญต่อรอบ'
}
]);

/* ==========================================================================
A. WEB APP ENTRY POINTS
• ========================================================================== */

/**
• This Apps Script Web App only provides a health endpoint.
• The frontend itself is hosted separately on GitHub Pages.
*/
function doGet(e) {
try {
var params = e && e.parameter ? e.parameter : {};
var mode = String(params.mode || 'health').toLowerCase();

if (mode === 'health') {
return jsonOutput_({
ok: true,
service: APP.NAME,
version: APP.VERSION,
time: nowIso_(),
architecture: 'GitHub Pages + Cloudflare Worker + Apps Script + Sheets'
});
}

return jsonOutput_({
ok: false,
error: 'Unsupported GET mode',
supported: ['health']
});
} catch (err) {
logError_('doGet', err);
return jsonOutput_({
ok: false,
error: safeError_(err)
});
}
}

/**
• Worker-to-Apps-Script request format:
• {
• "secret": "WORKER_SHARED_SECRET",
• "kind": "api",
• "action": "bootstrap",
• "payload": {}
• }
• Verified webhook request format:
• {
• "secret": "WORKER_SHARED_SECRET",
• "kind": "line_webhook",
• "signatureVerified": true,
• "body": { "destination": "...", "events": [] }
• }
*/
function doPost(e) {
try {
var raw = e && e.postData && e.postData.contents
? e.postData.contents
: '';

if (!raw) {
return jsonOutput_({
ok: false,
error: 'Empty request body'
});
}

var input;

try {
input = JSON.parse(raw);
} catch (parseError) {
return jsonOutput_({
ok: false,
error: 'Request body must be valid JSON'
});
}

if (!verifyWorkerSecret_(input.secret)) {
logSystem_(
'WARN',
'doPost',
'Rejected request: invalid worker secret',
{}
);

return jsonOutput_({
ok: false,
error: 'Unauthorized'
});
}

if (input.kind === 'line_webhook') {
if (input.signatureVerified !== true) {
return jsonOutput_({
ok: false,
error: 'LINE signature must be verified by Worker'
});
}

var webhookResult = processLineWebhook_(input.body || {});

return jsonOutput_({
ok: true,
result: webhookResult
});
}

if (input.kind !== 'api') {
return jsonOutput_({
ok: false,
error: 'Unsupported request kind'
});
}

var action = String(input.action || '').trim();
var payload = input.payload && typeof input.payload === 'object'
? input.payload
: {};

var result = dispatchApi_(action, payload);

return jsonOutput_({
ok: true,
action: action,
result: result
});

} catch (err) {
logError_('doPost', err);

return jsonOutput_({
ok: false,
error: safeError_(err)
});
}
}

/**
• Direct function for testing API actions inside the Apps Script editor.
• This function is not a replacement for the protected POST endpoint.
*/
function api(action, payload) {
return dispatchApi_(String(action || ''), payload || {});
}

function testBackend() {
var setup = setupSystem();

var result = {
ok: true,
version: APP.VERSION,
databaseUrl: setup.spreadsheetUrl,
tableCount: Object.keys(TABLE_SCHEMAS).length,
time: nowIso_()
};

Logger.log(JSON.stringify(result, null, 2));
return result;
}

/* ==========================================================================
B. DATABASE INITIALIZATION
• ========================================================================== */

function setupSystem() {
var ss = getDatabase_();

ensureAllSheets_();
seedDefaultSettings_();
seedDefaultPrompt_();
seedDefaultSafetyRules_();
createDefaultTemplates_();

logSystem_('INFO', 'setupSystem', 'System setup completed', {
spreadsheetId: ss.getId(),
tableCount: Object.keys(TABLE_SCHEMAS).length
});

return {
ok: true,
spreadsheetId: ss.getId(),
spreadsheetUrl: ss.getUrl(),
tableCount: Object.keys(TABLE_SCHEMAS).length,
tables: Object.keys(TABLE_SCHEMAS)
};
}

function getDatabase_() {
var props = PropertiesService.getScriptProperties();
var id = props.getProperty('SPREADSHEET_ID');

if (id) {
try {
return SpreadsheetApp.openById(id);
} catch (err) {
logSystem_(
'WARN',
'getDatabase_',
'Configured spreadsheet could not be opened',
{ error: safeError_(err) }
);
}
}

var ss = SpreadsheetApp.create(APP.NAME + ' Database');
props.setProperty('SPREADSHEET_ID', ss.getId());

return ss;
}

function getSpreadsheetId_() {
return getDatabase_().getId();
}

function ensureAllSheets_() {
var ss = getDatabase_();

Object.keys(TABLE_SCHEMAS).forEach(function(tableName) {
var sheet = ss.getSheetByName(tableName);

if (!sheet) {
sheet = ss.insertSheet(tableName);
}

ensureHeaders_(sheet, TABLE_SCHEMAS[tableName]);
sheet.setFrozenRows(1);
});

return true;
}

/**
• Adds missing headers without clearing or deleting old data.
• Missing columns are appended to the right.
*/
function ensureHeaders_(sheet, expectedHeaders) {
var lastColumn = sheet.getLastColumn();
var current = [];

if (lastColumn > 0) {
current = sheet.getRange(1, 1, 1, lastColumn)
.getValues()[0]
.map(function(value) {
return String(value || '').trim();
});
}

if (!current.length || current.every(function(value) {
return value === '';
})) {
sheet.getRange(1, 1, 1, expectedHeaders.length)
.setValues([expectedHeaders]);

sheet.getRange(1, 1, 1, expectedHeaders.length)
.setFontWeight('bold');

return;
}

var known = {};

current.forEach(function(header) {
if (header) known[header] = true;
});

var missing = expectedHeaders.filter(function(header) {
return !known[header];
});

if (missing.length) {
sheet.getRange(1, current.length + 1, 1, missing.length)
.setValues([missing]);

sheet.getRange(1, 1, 1, current.length + missing.length)
.setFontWeight('bold');
}
}

function seedDefaultSettings_() {
DEFAULT_SETTINGS.forEach(function(setting) {
var existing = findRecordByField_(
'Settings',
'key',
setting.key
);

if (!existing) {
saveRecord_('Settings', {
key: setting.key,
value: setting.value,
description: setting.description
});
}
});
}

function seedDefaultPrompt_() {
var all = listRecords_('Prompts', { limit: 100 });

var exists = all.some(function(item) {
return String(item.name || '').toLowerCase() === 'default';
});

if (exists) return;

saveRecord_('Prompts', {
name: 'default',
content:
'คุณเป็นผู้ช่วยของ LINE Official Account ตอบเป็นภาษาไทยสุภาพ ' +
'ใช้ข้อมูลจากผู้ใช้และฐานความรู้ที่มีเท่านั้น อย่าสร้างราคา เงื่อนไข ' +
'หรือข้อเท็จจริงที่ไม่มีแหล่งสนับสนุน หากไม่ทราบคำตอบให้แจ้งอย่างตรงไปตรงมา ' +
'และแนะนำให้ติดต่อเจ้าหน้าที่เมื่อเหมาะสม',
active: true,
version: 1,
description: 'Default Thai assistant prompt'
});
}

function seedDefaultSafetyRules_() {
if (listRecords_('SafetyRules', { limit: 100 }).length) return;

[
{
name: 'Protect secrets',
ruleType: 'security',
value: 'Never disclose API keys, channel tokens, passwords or secrets.',
enabled: true,
description: 'ป้องกันการเปิดเผยข้อมูลลับ'
},
{
name: 'Human handover',
ruleType: 'handover',
value: 'Route uncertain or human-agent requests to the Handover Queue.',
enabled: true,
description: 'ส่งต่อเจ้าหน้าที่เมื่อจำเป็น'
}
 ].forEach(function(item) {
saveRecord_('SafetyRules', item);
});
}

/* ==========================================================================
C. API ROUTER
• ========================================================================== */

function dispatchApi_(action, payload) {
var name = String(action || '').trim();
var p = payload || {};

if (!name) throw new Error('Missing API action');

switch (name) {
case 'health':
return {
ok: true,
version: APP.VERSION,
service: APP.NAME,
time: nowIso_()
};

case 'setup':
return setupSystem();

case 'bootstrap':
setupSystem();
return buildBootstrap_();

case 'dashboard':
return getDashboard_();

case 'getConfig':
return getPublicConfig_();

case 'setConfig':
return setConfig_(p);

case 'list':
return listRecords_(validateTable_(p.table), p);

case 'save':
return saveRecord_(
validateTable_(p.table),
p.record || p.data || {}
);

case 'delete':
return deleteRecord_(
validateTable_(p.table),
p.id
);

case 'getAnalytics':
return getAnalytics_(p);

case 'getConversation':
return getConversation_(p.userId, p.limit);

case 'getFriends':
return getFriendList_(p);

case 'syncFriendsFromLINE':
return syncFriendsFromLINE_(p);

case 'syncFriendProfiles':
return syncFriendProfiles_(p);

case 'getFollowerSyncStatus':
return getFollowerSyncStatus_();

case 'sendText':
return sendText_(p);

case 'sendFlex':
return sendFlex_(p);

case 'sendFlexToUsers':
return sendFlexToUsers_(p);

case 'previewFlex':
return previewFlex_(p);

case 'sendWelcomeTest':
return sendWelcomeTest_(p);

case 'startLoading':
return startLoading_(p);

case 'setFriendAI':
return setFriendAI_(p);

case 'sendAdminReply':
return sendAdminReply_(p);

case 'addFriendTag':
return changeFriendTag_(p, true);

case 'removeFriendTag':
return changeFriendTag_(p, false);

case 'savePromptVersion':
return savePromptVersion_(p);

case 'testAI':
return testAI_(p);

case 'previewAI':
return previewAI_(p);

case 'testLineConnection':
return testLineConnection_(p.channelId);

case 'saveChannelCredentials':
return saveChannelCredentials_(p);

case 'createKnowledgeDocument':
return createKnowledgeDocument_(p);

case 'rebuildKnowledge':
return rebuildKnowledge_();

case 'createDefaultTemplates':
return createDefaultTemplates_();

case 'sendCampaignNow':
return sendCampaignNow_(p);

case 'runScheduledCampaigns':
return runScheduledCampaigns_();

case 'installTriggers':
return installTriggers_();

case 'removeTriggers':
return removeTriggers_();

case 'runMaintenance':
return runMaintenance_();

case 'exportTableCsv':
return exportTableCsv_(p);

case 'createRichMenu':
return createRichMenu_(p);

case 'uploadRichMenuImage':
return uploadRichMenuImage_(p);

case 'linkRichMenu':
return linkRichMenu_(p);

case 'unlinkRichMenu':
return unlinkRichMenu_(p);

case 'setDefaultRichMenu':
return setDefaultRichMenu_(p);

case 'clearDefaultRichMenu':
return clearDefaultRichMenu_(p);

case 'deleteRichMenu':
return deleteRichMenu_(p);

case 'closeHandover':
return closeHandover_(p);

case 'refreshHandoverLoadingIndicators':
return refreshHandoverLoadingIndicators_();

case 'processScheduledJobs':
return processScheduledJobs_();

default:
throw new Error('Unsupported API action: ' + name);
}
}

function buildBootstrap_() {
var result = {
app: {
name: APP.NAME,
version: APP.VERSION,
timezone: APP.TIMEZONE
},
config: getPublicConfig_(),
dashboard: getDashboard_(),
tables: {}
};

[
'Friends',
'ChatSessions',
'Prompts',
'KnowledgeBase',
'Documents',
'FlexTemplates',
'WelcomeFlow',
'AutomationRules',
'Campaigns',
'AIProfiles',
'Channels',
'RichMenus',
'SafetyRules',
'HandoverQueue'
 ].forEach(function(tableName) {
result.tables[tableName] = listRecords_(tableName, {
limit: tableName === 'Friends' ? 500 : 200
});
});

return result;
}

/* ==========================================================================
D. GENERIC DATABASE OPERATIONS
• ========================================================================== */

function validateTable_(tableName) {
var requested = String(tableName || '').trim();

var match = FRONTEND_TABLES.find(function(name) {
return name.toLowerCase() === requested.toLowerCase();
});

if (!match) {
throw new Error('Table is not available: ' + requested);
}

return match;
}

function getSheet_(tableName) {
if (!TABLE_SCHEMAS[tableName]) {
throw new Error('Unknown table: ' + tableName);
}

var ss = getDatabase_();
var sheet = ss.getSheetByName(tableName);

if (!sheet) {
sheet = ss.insertSheet(tableName);
}

ensureHeaders_(sheet, TABLE_SCHEMAS[tableName]);

return sheet;
}

function getHeaders_(sheet) {
var last = sheet.getLastColumn();

if (!last) return [];

return sheet.getRange(1, 1, 1, last)
.getValues()[0]
.map(function(value) {
return String(value || '').trim();
});
}

function serializeCell_(value) {
if (value === undefined || value === null) return '';

if (typeof value === 'object') {
return JSON.stringify(value);
}

if (typeof value === 'string' && /^[=+@]/.test(value)) {
return "'" + value;
}

return value;
}

function deserializeCell_(value) {
if (typeof value !== 'string') return value;

var trimmed = value.trim();

if (!trimmed) return '';

var seemsJson =
(trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') ||
(trimmed.charAt(0) === '[' && trimmed.charAt(trimmed.length - 1) === ']');

if (seemsJson) {
try {
return JSON.parse(trimmed);
} catch (err) {
return value;
}
}

return value;
}

function rowToObject_(headers, row) {
var out = {};

headers.forEach(function(header, index) {
if (header) out[header] = deserializeCell_(row[index]);
});

return out;
}

function objectToRow_(headers, object) {
return headers.map(function(header) {
return header ? serializeCell_(object[header]) : '';
});
}

function listRecords_(tableName, options) {
var table = validateTable_(tableName);
var opts = options || {};
var sheet = getSheet_(table);
var headers = getHeaders_(sheet);
var lastRow = sheet.getLastRow();

if (lastRow < 2) return [];

var count = Math.min(lastRow - 1, APP.MAX_LIST_ROWS);
var values = sheet.getRange(2, 1, count, headers.length).getValues();

var records = values.map(function(row) {
return rowToObject_(headers, row);
}).filter(function(item) {
return Boolean(item.id || item.key || item.userId);
});

if (opts.search) {
var query = String(opts.search).toLowerCase();

records = records.filter(function(item) {
return JSON.stringify(item).toLowerCase().indexOf(query) >= 0;
});
}

if (opts.field && opts.value !== undefined) {
records = records.filter(function(item) {
return String(item[opts.field]) === String(opts.value);
});
}

if (opts.enabled !== undefined) {
records = records.filter(function(item) {
return toBoolean_(item.enabled) === toBoolean_(opts.enabled);
});
}

if (opts.status !== undefined) {
records = records.filter(function(item) {
return String(item.status || '') === String(opts.status);
});
}

records.sort(function(a, b) {
var dateA = String(a.updatedAt || a.timestamp || a.createdAt || '');
var dateB = String(b.updatedAt || b.timestamp || b.createdAt || '');
return dateB.localeCompare(dateA);
});

var offset = Math.max(0, Number(opts.offset || 0));
var limit = Math.max(
1,
Math.min(Number(opts.limit || 200), APP.MAX_LIST_ROWS)
);

return records.slice(offset, offset + limit);
}

function getRecordById_(tableName, id) {
if (!id) return null;

var table = validateTable_(tableName);
var sheet = getSheet_(table);
var headers = getHeaders_(sheet);
var idColumn = headers.indexOf('id');

if (idColumn < 0 || sheet.getLastRow() < 2) return null;

var count = sheet.getLastRow() - 1;
var values = sheet.getRange(2, 1, count, headers.length).getValues();

for (var i = 0; i < values.length; i++) {
if (String(values[i][idColumn]) === String(id)) {
return {
rowNumber: i + 2,
record: rowToObject_(headers, values[i])
};
}
}

return null;
}

function findRecordByField_(tableName, field, value) {
var table = validateTable_(tableName);
var sheet = getSheet_(table);
var headers = getHeaders_(sheet);
var column = headers.indexOf(field);

if (column < 0 || sheet.getLastRow() < 2) return null;

var count = sheet.getLastRow() - 1;
var values = sheet.getRange(2, 1, count, headers.length).getValues();

for (var i = 0; i < values.length; i++) {
if (String(values[i][column]) === String(value)) {
return {
rowNumber: i + 2,
record: rowToObject_(headers, values[i])
};
}
}

return null;
}

/**
• Safe generic create/update. Existing createdAt is preserved.
• No automatic deletion or whole-sheet clearing occurs here.
*/
function saveRecord_(tableName, inputRecord) {
var table = validateTable_(tableName);
var input = inputRecord || {};
var lock = LockService.getScriptLock();

lock.waitLock(20000);

try {
var sheet = getSheet_(table);
var headers = getHeaders_(sheet);
var id = String(input.id || '').trim();
var existing = id ? getRecordById_(table, id) : null;
var now = nowIso_();

var record = existing
? Object.assign({}, existing.record)
: {};

Object.keys(input).forEach(function(key) {
if (headers.indexOf(key) >= 0) {
record[key] = input[key];
}
});

if (!record.id) record.id = Utilities.getUuid();
if (!record.createdAt) record.createdAt = now;
record.updatedAt = now;

var row = objectToRow_(headers, record);

if (existing) {
sheet.getRange(existing.rowNumber, 1, 1, headers.length)
.setValues([row]);
} else {
sheet.appendRow(row);
}

if (LOG_EXCLUDED_TABLES.indexOf(table) < 0) {
logAdmin_(
existing ? 'update_record' : 'create_record',
table,
record.id,
{ fields: Object.keys(input) },
'success'
);
}

return record;

} finally {
lock.releaseLock();
}
}

function appendRecordsDirect_(tableName, records) {
if (!records || !records.length) return 0;

var sheet = getSheet_(tableName);
var headers = getHeaders_(sheet);

var rows = records.map(function(record) {
return objectToRow_(headers, record);
});

sheet.getRange(
sheet.getLastRow() + 1,
1,
rows.length,
headers.length
).setValues(rows);

return rows.length;
}

function deleteRecord_(tableName, id) {
var table = validateTable_(tableName);

if (READ_ONLY_TABLES.indexOf(table) >= 0) {
throw new Error('Deleting records from ' + table + ' is disabled');
}

if (!id) throw new Error('Missing record id');

var lock = LockService.getScriptLock();
lock.waitLock(20000);

try {
var result = getRecordById_(table, id);

if (!result) {
return {
deleted: false,
message: 'Record not found'
};
}

getSheet_(table).deleteRow(result.rowNumber);

logAdmin_(
'delete_record',
table,
id,
{},
'success'
);

return {
deleted: true,
id: String(id)
};

} finally {
lock.releaseLock();
}
}

/* ==========================================================================
E. SETTINGS AND SECURITY
• ========================================================================== */

function getPublicConfig_() {
var rows = listRecords_('Settings', { limit: 500 });
var out = {};

rows.forEach(function(row) {
if (row.key) out[row.key] = row.value;
});

var props = PropertiesService.getScriptProperties();

// Keep the legacy field for compatibility with existing GitHub frontend.
out.geminiConfigured = Boolean(props.getProperty('GEMINI_API_KEY'));
out.openaiConfigured = out.geminiConfigured;
out.defaultLineConfigured = Boolean(
props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')
);
out.workerSecretConfigured = Boolean(
props.getProperty('WORKER_SHARED_SECRET')
);
out.spreadsheetConfigured = Boolean(
props.getProperty('SPREADSHEET_ID')
);

return out;
}

function setConfig_(payload) {
var input = payload || {};

if (!input.key) throw new Error('Missing setting key');

var allowed = DEFAULT_SETTINGS.map(function(item) {
return item.key;
});

var key = String(input.key);

if (allowed.indexOf(key) < 0) {
throw new Error('Setting key is not allowed: ' + key);
}

var current = findRecordByField_('Settings', 'key', key);
var record = {
key: key,
value: String(input.value === undefined ? '' : input.value),
description: input.description || ''
};

if (current) record.id = current.record.id;

return saveRecord_('Settings', record);
}

function verifyWorkerSecret_(candidate) {
var expected = PropertiesService.getScriptProperties()
.getProperty('WORKER_SHARED_SECRET');

if (!expected || !candidate) return false;

return constantTimeEquals_(String(expected), String(candidate));
}

function constantTimeEquals_(a, b) {
if (a.length !== b.length) return false;

var diff = 0;

for (var i = 0; i < a.length; i++) {
diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
}

return diff === 0;
}

function showRequiredScriptProperties() {
var required = [
'SPREADSHEET_ID',
'WORKER_SHARED_SECRET',
'GEMINI_API_KEY',
'GEMINI_MODEL',
'LINE_CHANNEL_ACCESS_TOKEN',
'DEFAULT_CHANNEL_ID'
 ];

var props = PropertiesService.getScriptProperties().getProperties();

var report = required.map(function(name) {
return {
property: name,
configured: Boolean(props[name])
};
});

Logger.log(JSON.stringify(report, null, 2));
return report;
}

/* ==========================================================================
F. DASHBOARD AND ANALYTICS
• ========================================================================== */

function getDashboard_() {
var friends = listRecords_('Friends', { limit: APP.MAX_LIST_ROWS });
var sessions = listRecords_('ChatSessions', { limit: APP.MAX_LIST_ROWS });
var chats = listRecords_('ChatLogs', { limit: APP.MAX_LIST_ROWS });
var campaigns = listRecords_('Campaigns', { limit: 1000 });
var handovers = listRecords_('HandoverQueue', { limit: 1000 });

var today = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd');

var todayMessages = chats.filter(function(item) {
return String(item.timestamp || '').indexOf(today) === 0;
});

var openHandovers = handovers.filter(function(item) {
return String(item.status || 'open').toLowerCase() !== 'closed';
});

var activeCampaigns = campaigns.filter(function(item) {
return ['queued', 'scheduled', 'sending'].indexOf(
String(item.status || '').toLowerCase()
) >= 0;
});

return {
app: APP.NAME,
version: APP.VERSION,
generatedAt: nowIso_(),
totals: {
friends: friends.length,
sessions: sessions.length,
messages: chats.length,
messagesToday: todayMessages.length,
campaigns: campaigns.length,
activeCampaigns: activeCampaigns.length,
openHandovers: openHandovers.length
},
config: {
aiEnabled: getSettingBoolean_('ai_enabled', true),
welcomeEnabled: getSettingBoolean_('welcome_enabled', true),
knowledgeEnabled: getSettingBoolean_('knowledge_enabled', true)
},
recentMessages: chats.slice(0, 10),
recentCampaigns: campaigns.slice(0, 10),
recentHandovers: openHandovers.slice(0, 10)
};
}

function getAnalytics_(payload) {
var input = payload || {};
var days = Math.max(1, Math.min(Number(input.days || 7), 90));
var first = new Date();

first.setDate(first.getDate() - days + 1);

var daily = {};

for (var i = 0; i < days; i++) {
var day = new Date(first);
day.setDate(first.getDate() + i);

var dateKey = Utilities.formatDate(
day,
APP.TIMEZONE,
'yyyy-MM-dd'
);

daily[dateKey] = {
date: dateKey,
inbound: 0,
outbound: 0,
total: 0
};
}

var messages = listRecords_('ChatLogs', {
limit: APP.MAX_LIST_ROWS
});

messages.forEach(function(message) {
var dateKey = String(message.timestamp || '').substring(0, 10);

if (!daily[dateKey]) return;

if (message.direction === 'inbound') {
daily[dateKey].inbound++;
}

if (message.direction === 'outbound') {
daily[dateKey].outbound++;
}

daily[dateKey].total++;
});

return {
periodDays: days,
startDate: Utilities.formatDate(first, APP.TIMEZONE, 'yyyy-MM-dd'),
generatedAt: nowIso_(),
summary: {
friends: listRecords_('Friends', { limit: APP.MAX_LIST_ROWS }).length,
campaigns: listRecords_('Campaigns', { limit: 1000 }).length,
messages: messages.length
},
daily: Object.keys(daily).sort().map(function(key) {
return daily[key];
})
};
}

/* ==========================================================================
G. FRIEND MANAGER: LIST, SEARCH AND FILTER
• ========================================================================== */

/**
• Returns known friends from Google Sheets.
• Use syncFriendsFromLINE first if your account can access the follower IDs API.
• Frontend call:
• action = "getFriends"
• payload = { search:"name", status:"active", tag:"vip", limit:200, offset:0 }
*/
function getFriendList_(payload) {
var p = payload || {};
var records = listRecords_('Friends', {
limit: APP.MAX_LIST_ROWS
});

if (p.status) {
records = records.filter(function(item) {
return String(item.status || '').toLowerCase() ===
String(p.status).toLowerCase();
});
}

if (p.tag) {
var tag = String(p.tag).toLowerCase();

records = records.filter(function(item) {
return parseTags_(item.tags).some(function(value) {
return value.toLowerCase() === tag;
});
});
}

if (p.aiEnabled !== undefined) {
records = records.filter(function(item) {
return toBoolean_(item.aiEnabled) === toBoolean_(p.aiEnabled);
});
}

if (p.search) {
var query = String(p.search).toLowerCase();

records = records.filter(function(item) {
var combined = [
item.displayName,
item.userId,
item.statusMessage,
item.notes,
item.tags
 ].join(' ').toLowerCase();

return combined.indexOf(query) >= 0;
});
}

records.sort(function(a, b) {
return String(b.lastSeenAt || b.createdAt || '')
.localeCompare(String(a.lastSeenAt || a.createdAt || ''));
});

var total = records.length;
var offset = Math.max(0, Number(p.offset || 0));
var limit = Math.max(1, Math.min(Number(p.limit || 200), 1000));

return {
ok: true,
total: total,
offset: offset,
limit: limit,
friends: records.slice(offset, offset + limit)
};
}

/**
• Create or update a friend row. It never deletes other friends.
*/
function upsertFriend_(userId, data) {
var id = String(userId || '').trim();
if (!id) throw new Error('userId is required');

var input = data || {};
var existing = findRecordByField_('Friends', 'userId', id);

var safe = Object.assign({
userId: id,
displayName: '',
pictureUrl: '',
statusMessage: '',
language: '',
status: 'active',
tags: '',
aiEnabled: true,
notes: '',
assignedTo: '',
lastMessage: '',
lastMessageAt: '',
lastSeenAt: nowIso_()
}, input, {
userId: id
});

if (existing) safe.id = existing.record.id;

return saveRecord_('Friends', safe);
}

function getOrCreateSession_(userId, displayName) {
var existing = findRecordByField_('ChatSessions', 'userId', userId);

if (existing) {
return saveRecord_('ChatSessions', {
id: existing.record.id,
userId: userId,
displayName: displayName || existing.record.displayName,
updatedAt: nowIso_()
});
}

return saveRecord_('ChatSessions', {
userId: userId,
displayName: displayName || '',
status: 'open',
assignedTo: '',
lastMessage: '',
lastMessageAt: '',
unreadCount: 0,
aiEnabled: true,
tags: ''
});
}

/* ==========================================================================
H. SYNC ALL FRIENDS FROM LINE
• ========================================================================== */

/**
• Gets follower User IDs from LINE.
• IMPORTANT:
◦ LINE only enables this endpoint for verified or premium accounts.
◦ User profile details are fetched separately by syncFriendProfiles().
◦ Pagination cursor is stored in Script Properties for subsequent calls.
• Payload:
• {
• "channelId": "channel-sheet-row-id",
• "limit": 1000,
• "maxPages": 5,
• "reset": false
• }
*/
function syncFriendsFromLINE_(payload) {
var p = payload || {};
var props = PropertiesService.getScriptProperties();

var cursor = p.reset
? ''
: String(props.getProperty('FOLLOWER_SYNC_CURSOR') || '');

var limit = Math.max(1, Math.min(Number(p.limit || 1000), 1000));
var maxPages = Math.max(1, Math.min(Number(p.maxPages || 3), 10));

var pagesFetched = 0;
var idsAdded = 0;
var idsSeen = 0;
var hasMore = false;
var channelId = String(p.channelId || '');

for (var page = 0; page < maxPages; page++) {
var path = '/v2/bot/followers/ids?limit=' + limit;

if (cursor) {
path += '&start=' + encodeURIComponent(cursor);
}

var response;

try {
response = lineApi_(path, 'get', null, channelId);
} catch (err) {
logError_('syncFriendsFromLINE_', err);

return {
ok: false,
pagesFetched: pagesFetched,
idsAdded: idsAdded,
idsSeen: idsSeen,
error: safeError_(err),
hint:
'หากได้ HTTP 403 บัญชี LINE Official Account อาจไม่ใช่ Verified หรือ Premium'
};
}

pagesFetched++;

var ids = Array.isArray(response.userIds) ? response.userIds : [];
idsSeen += ids.length;

ids.forEach(function(userId) {
var existing = findRecordByField_('Friends', 'userId', userId);

if (existing) {
saveRecord_('Friends', {
id: existing.record.id,
userId: userId,
status: 'active',
lastSeenAt: nowIso_()
});
} else {
upsertFriend_(userId, {
displayName: '',
status: 'active',
aiEnabled: true,
lastSeenAt: nowIso_()
});

idsAdded++;
}
});

cursor = String(response.next || '');
hasMore = Boolean(cursor);

if (!hasMore) break;
}

if (cursor) {
props.setProperty('FOLLOWER_SYNC_CURSOR', cursor);
} else {
props.deleteProperty('FOLLOWER_SYNC_CURSOR');
props.setProperty('FOLLOWER_SYNC_COMPLETED_AT', nowIso_());
}

props.setProperty('FOLLOWER_SYNC_LAST_AT', nowIso_());

var result = {
ok: true,
pagesFetched: pagesFetched,
idsSeen: idsSeen,
idsAdded: idsAdded,
hasMore: hasMore,
nextRunRequired: hasMore,
syncedAt: nowIso_()
};

logAdmin_(
'sync_friends_from_line',
'Friends',
'',
result,
'success'
);

return result;
}

function getFollowerSyncStatus_() {
var props = PropertiesService.getScriptProperties();

return {
hasContinuationCursor: Boolean(
props.getProperty('FOLLOWER_SYNC_CURSOR')
),
lastSyncAt: props.getProperty('FOLLOWER_SYNC_LAST_AT') || '',
completedAt: props.getProperty('FOLLOWER_SYNC_COMPLETED_AT') || '',
friendRows: listRecords_('Friends', {
limit: APP.MAX_LIST_ROWS
}).length
};
}

/**
• Enriches friends whose profile details are missing.
• Small batches reduce the risk of exceeding Apps Script execution limits.
• Payload: { channelId:"...", limit:20 }
*/
function syncFriendProfiles_(payload) {
var p = payload || {};
var limit = Math.max(1, Math.min(Number(p.limit || 20), 50));
var channelId = String(p.channelId || '');

var friends = listRecords_('Friends', {
limit: APP.MAX_LIST_ROWS
}).filter(function(item) {
return item.userId && !item.displayName;
}).slice(0, limit);

var updated = 0;
var skipped = 0;
var errors = [];

friends.forEach(function(friend) {
try {
var profile = getLineProfile_(friend.userId, channelId);

if (!profile) {
skipped++;
return;
}

saveRecord_('Friends', {
id: friend.id,
userId: friend.userId,
displayName: profile.displayName || '',
pictureUrl: profile.pictureUrl || '',
statusMessage: profile.statusMessage || '',
language: profile.language || '',
status: 'active',
lastSeenAt: nowIso_()
});

updated++;

} catch (err) {
skipped++;

errors.push({
userId: friend.userId,
error: safeError_(err)
});
}
});

return {
ok: true,
requested: friends.length,
updated: updated,
skipped: skipped,
errors: errors
};
}

/* ==========================================================================
I. FRIEND TAGS, AI TOGGLE AND HANDOVER
• ========================================================================== */

function changeFriendTag_(payload, add) {
var p = payload || {};
var userId = String(p.userId || '');
var tag = String(p.tag || '').trim();

if (!userId || !tag) {
throw new Error('userId and tag are required');
}

var existing = findRecordByField_('Friends', 'userId', userId);
var friend = existing ? existing.record : upsertFriend_(userId, {});
var tags = parseTags_(friend.tags);

var nextTags;

if (add) {
nextTags = Array.from(new Set(tags.concat([tag])));
} else {
nextTags = tags.filter(function(item) {
return item !== tag;
});
}

return saveRecord_('Friends', {
id: friend.id,
userId: userId,
tags: nextTags.join(',')
});
}

function setFriendAI_(payload) {
var p = payload || {};
var userId = String(p.userId || '');

if (!userId) throw new Error('userId is required');

var existing = findRecordByField_('Friends', 'userId', userId);
var friend = existing ? existing.record : upsertFriend_(userId, {});
var enabled = toBoolean_(p.enabled);

var updated = saveRecord_('Friends', {
id: friend.id,
userId: userId,
aiEnabled: enabled
});

var session = findRecordByField_('ChatSessions', 'userId', userId);

if (session) {
saveRecord_('ChatSessions', {
id: session.record.id,
userId: userId,
aiEnabled: enabled
});
}

return {
ok: true,
friend: updated
};
}

function createHandover_(userId, displayName, reason) {
if (!userId) throw new Error('userId is required');

var existing = listRecords_('HandoverQueue', {
limit: 1000,
field: 'userId',
value: userId
}).find(function(item) {
return String(item.status || '').toLowerCase() !== 'closed';
});

if (existing) return existing;

var handover = saveRecord_('HandoverQueue', {
userId: userId,
displayName: displayName || '',
reason: String(reason || ''),
status: 'open',
assignedTo: ''
});

var session = findRecordByField_('ChatSessions', 'userId', userId);

if (session) {
saveRecord_('ChatSessions', {
id: session.record.id,
userId: userId,
status: 'handover',
aiEnabled: false
});
}

var friend = findRecordByField_('Friends', 'userId', userId);
if (friend) {
saveRecord_('Friends', {
id: friend.record.id,
userId: userId,
aiEnabled: false
});
}

return handover;
}

function closeHandover_(payload) {
var p = payload || {};
var id = String(p.id || '');

if (!id) throw new Error('Handover id is required');

var item = getRecordById_('HandoverQueue', id);

if (!item) throw new Error('Handover record not found');

return saveRecord_('HandoverQueue', {
id: id,
status: 'closed',
assignedTo: p.assignedTo || item.record.assignedTo || '',
closedAt: nowIso_()
});
}

/* ==========================================================================
J. CONVERSATION INBOX AND MESSAGE LOGS
• ========================================================================== */

function getConversation_(userId, limit) {
var id = String(userId || '');

if (!id) throw new Error('userId is required');

var max = Math.max(
1,
Math.min(Number(limit || 100), APP.MAX_CONVERSATION_ROWS)
);

var messages = listRecords_('ChatLogs', {
field: 'userId',
value: id,
limit: APP.MAX_LIST_ROWS
});

messages.sort(function(a, b) {
return String(a.timestamp || '').localeCompare(
String(b.timestamp || '')
);
});

var session = findRecordByField_('ChatSessions', 'userId', id);
var friend = findRecordByField_('Friends', 'userId', id);

return {
userId: id,
messages: messages.slice(-max),
session: session ? session.record : null,
friend: friend ? friend.record : null
};
}

function logChat_(data) {
var p = data || {};

return saveRecord_('ChatLogs', {
timestamp: p.timestamp || nowIso_(),
userId: p.userId || '',
displayName: p.displayName || '',
direction: p.direction || '',
messageType: p.messageType || '',
text: String(p.text || '').substring(0, APP.MAX_TEXT_LENGTH),
messageJson: p.messageJson || {},
source: p.source || '',
status: p.status || '',
campaignId: p.campaignId || '',
channelId: p.channelId || ''
});
}

function updateFriendLastMessage_(userId, text) {
var existing = findRecordByField_('Friends', 'userId', userId);

if (existing) {
return saveRecord_('Friends', {
id: existing.record.id,
userId: userId,
lastMessage: String(text || '').substring(0, 500),
lastMessageAt: nowIso_(),
lastSeenAt: nowIso_()
});
}

return upsertFriend_(userId, {
lastMessage: String(text || '').substring(0, 500),
lastMessageAt: nowIso_()
});
}

function incrementSession_(userId, update) {
var existing = findRecordByField_('ChatSessions', 'userId', userId);

if (existing) {
var current = Object.assign({}, update || {});

current.id = existing.record.id;
current.userId = userId;

return saveRecord_('ChatSessions', current);
}

return getOrCreateSession_(userId, '');
}

function incrementUnread_(userId) {
var session = findRecordByField_('ChatSessions', 'userId', userId);

if (!session) return getOrCreateSession_(userId, '');

return saveRecord_('ChatSessions', {
id: session.record.id,
userId: userId,
unreadCount: Number(session.record.unreadCount || 0) + 1,
lastMessageAt: nowIso_()
});
}

function sendAdminReply_(payload) {
var p = payload || {};
var userId = String(p.userId || '');
var text = String(p.text || '').trim();

if (!userId || !text) {
throw new Error('userId and text are required');
}

var response = sendText_({
userId: userId,
text: text,
channelId: p.channelId
});

/* An outgoing staff reply should end the pending-human loading cycle. */
var activeHandovers = listRecords_('HandoverQueue', {
limit: 1000,
field: 'userId',
value: userId
}).filter(function(item) {
return String(item.status || '').toLowerCase() !== 'closed';
});

activeHandovers.forEach(function(item) {
saveRecord_('HandoverQueue', {
id: item.id,
status: 'closed',
assignedTo: p.assignedTo || item.assignedTo || 'admin',
closedAt: nowIso_()
});
});

var session = findRecordByField_('ChatSessions', 'userId', userId);

if (session) {
saveRecord_('ChatSessions', {
id: session.record.id,
status: 'open',
assignedTo: p.assignedTo || session.record.assignedTo || '',
lastMessage: text,
lastMessageAt: nowIso_(),
unreadCount: 0
});
}

logAdmin_(
'admin_reply',
'ChatSessions',
userId,
{ textLength: text.length },
'success'
);

return response;
}

/* ==========================================================================
K. MULTI-CHANNEL LINE CONFIGURATION
• ========================================================================== */

/**
• Save a channel record's access token in Script Properties.
• The raw token is not written into the Channels sheet or returned.
• payload: { channelId: "sheet-record-id", accessToken: "..." }
*/
function saveChannelCredentials_(payload) {
var p = payload || {};
var id = String(p.channelId || '');
var token = String(p.accessToken || '');

if (!id || !token) {
throw new Error('channelId and accessToken are required');
}

var result = getRecordById_('Channels', id);

if (!result) throw new Error('Channel record not found');

var propertyName = 'LINE_TOKEN_' +
String(id).replace(/[^a-zA-Z0-9_]/g, '_');

PropertiesService.getScriptProperties()
.setProperty(propertyName, token);

var updated = saveRecord_('Channels', {
id: id,
tokenProperty: propertyName,
enabled: true
});

return {
ok: true,
channelId: id,
channelName: updated.name,
tokenConfigured: true
};
}

function getChannelToken_(channelId) {
var props = PropertiesService.getScriptProperties();

if (channelId) {
var result = getRecordById_('Channels', String(channelId));

if (!result) throw new Error('Channel not found: ' + channelId);

var channel = result.record;

if (!toBoolean_(channel.enabled)) {
throw new Error('LINE channel is disabled');
}

if (channel.tokenProperty) {
var configured = props.getProperty(String(channel.tokenProperty));

if (configured) return configured;
}
}

if (!channelId) {
var defaultId = getSetting_('default_channel_id', '');

if (defaultId) {
var defaultRecord = getRecordById_('Channels', defaultId);

if (defaultRecord && defaultRecord.record.tokenProperty) {
var defaultToken = props.getProperty(
String(defaultRecord.record.tokenProperty)
);

if (defaultToken) return defaultToken;
}
}
}

var fallback = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');

if (fallback) return fallback;

throw new Error('LINE access token is not configured');
}

function resolveChannelIdFromDestination_(destination) {
if (!destination) return '';

var channels = listRecords_('Channels', { limit: 1000 });

var match = channels.find(function(channel) {
return String(channel.channelId || '') === String(destination);
});

return match ? match.id : '';
}

/* ==========================================================================
L. LINE API HELPERS
• ========================================================================== */

function lineApi_(path, method, body, channelId) {
var token = getChannelToken_(channelId);
var opts = {
method: String(method || 'get').toLowerCase(),
headers: {
Authorization: 'Bearer ' + token
},
muteHttpExceptions: true
};

if (body !== undefined && body !== null) {
opts.contentType = 'application/json';
opts.payload = JSON.stringify(body);
}

var response = UrlFetchApp.fetch(APP.LINE_ENDPOINT + path, opts);
var code = response.getResponseCode();
var text = response.getContentText();
var result = {};

try {
result = text ? JSON.parse(text) : {};
} catch (err) {
result = { raw: text };
}

if (code < 200 || code >= 300) {
var message = result.message || text || 'Unknown LINE API error';

logSystem_('ERROR', 'lineApi_', 'LINE API request failed', {
path: path,
method: method,
httpCode: code,
response: String(message).substring(0, 1200)
});

throw new Error('LINE API error (' + code + '): ' + message);
}

return result;
}

/**
• Rich menu image uses api-data.line.me, not api.line.me.
*/
function lineUploadRichMenuImage_(richMenuId, bytes, contentType, channelId) {
var token = getChannelToken_(channelId);

var response = UrlFetchApp.fetch(
APP.LINE_DATA_ENDPOINT +
'/v2/bot/richmenu/' +
encodeURIComponent(richMenuId) +
'/content',
{
method: 'post',
contentType: contentType || 'image/png',
headers: {
Authorization: 'Bearer ' + token
},
payload: bytes,
muteHttpExceptions: true
}
);

var code = response.getResponseCode();

if (code < 200 || code >= 300) {
throw new Error(
'LINE rich menu image upload failed (' +
code + '): ' + response.getContentText()
);
}

return {
ok: true,
httpCode: code
};
}

function testLineConnection_(channelId) {
return {
ok: true,
bot: lineApi_('/v2/bot/info', 'get', null, channelId),
checkedAt: nowIso_()
};
}

function getLineProfile_(userId, channelId) {
try {
return lineApi_(
'/v2/bot/profile/' + encodeURIComponent(userId),
'get',
null,
channelId
);
} catch (err) {
logSystem_('WARN', 'getLineProfile_', 'Could not get LINE profile', {
userId: userId,
error: safeError_(err)
});

return null;
}
}

/* ==========================================================================
M. SEND TEXT AND FLEX MESSAGES
• ========================================================================== */

function sendText_(payload) {
var p = payload || {};
var userId = String(p.userId || p.to || '').trim();
var text = String(p.text || '').trim();

if (!userId || !text) {
throw new Error('userId and text are required');
}

text = text.substring(0, APP.MAX_TEXT_LENGTH);

var result = lineApi_(
'/v2/bot/message/push',
'post',
{
to: userId,
messages: [{
type: 'text',
text: text
}]
},
p.channelId
);

logChat_({
userId: userId,
direction: 'outbound',
messageType: 'text',
text: text,
source: p.source || 'admin',
status: 'sent',
channelId: p.channelId || ''
});

incrementSession_(userId, {
lastMessage: text.substring(0, 500),
lastMessageAt: nowIso_()
});

updateFriendLastMessage_(userId, text);

return {
ok: true,
result: result
};
}

function getFlexContents_(payload) {
var p = payload || {};

if (p.templateId) {
var template = getRecordById_('FlexTemplates', p.templateId);

if (!template) throw new Error('Flex template not found');

return {
altText: String(
p.altText ||
template.record.altText ||
template.record.name ||
'Flex message'
).substring(0, 400),
contents: parseJsonObject_(
template.record.contents,
'Flex template contents'
)
};
}

return {
altText: String(p.altText || 'ข้อความจาก LINE').substring(0, 400),
contents: parseJsonObject_(
p.contents || p.flex,
'Flex contents'
)
};
}

function sendFlex_(payload) {
var p = payload || {};
var userId = String(p.userId || p.to || '').trim();

if (!userId) throw new Error('userId is required');

var flex = getFlexContents_(p);

var message = {
type: 'flex',
altText: flex.altText,
contents: flex.contents
};

var result = lineApi_(
'/v2/bot/message/push',
'post',
{
to: userId,
messages: [message]
},
p.channelId
);

logChat_({
userId: userId,
direction: 'outbound',
messageType: 'flex',
text: flex.altText,
messageJson: message,
source: 'admin',
status: 'sent',
channelId: p.channelId || ''
});

incrementSession_(userId, {
lastMessage: '[Flex] ' + flex.altText,
lastMessageAt: nowIso_()
});

return {
ok: true,
result: result
};
}

/**
• Main feature requested:
• Send one Flex Message to a selected list of friends.
• Payload:
• {
• "userIds": ["U...","U..."],
• "templateId": "sheet-record-id"
• }
• or
• {
• "userIds": ["U...","U..."],
• "altText": "Promotion",
• "contents": { "type":"bubble", ... }
• }
• LINE multicast permits up to 500 user IDs per request.
• The function rejects >500 users instead of silently truncating the selection.
*/
function sendFlexToUsers_(payload) {
var p = payload || {};
var rawIds = Array.isArray(p.userIds) ? p.userIds : [];

var ids = Array.from(new Set(rawIds.map(function(id) {
return String(id || '').trim();
}))).filter(function(id) {
return /^U[a-f0-9]{32}$/i.test(id);
});

if (!ids.length) {
throw new Error('Select at least one valid LINE user ID');
}

if (ids.length > APP.MAX_MULTICAST_USERS) {
throw new Error(
'This action accepts up to 500 selected friends per request. ' +
'Use a Campaign for larger recipient lists.'
);
}

var flex = getFlexContents_(p);

var message = {
type: 'flex',
altText: flex.altText,
contents: flex.contents
};

var result = lineApi_(
'/v2/bot/message/multicast',
'post',
{
to: ids,
messages: [message]
},
p.channelId
);

var timestamp = nowIso_();

var logs = ids.map(function(userId) {
return {
id: Utilities.getUuid(),
timestamp: timestamp,
userId: userId,
displayName: getFriendDisplayName_(userId),
direction: 'outbound',
messageType: 'flex',
text: flex.altText,
messageJson: message,
source: 'selected_friends_flex',
status: 'sent',
campaignId: p.campaignId || '',
channelId: p.channelId || ''
};
});

appendRecordsDirect_('ChatLogs', logs);

logAdmin_(
'send_flex_to_selected_friends',
'Friends',
'',
{
recipientCount: ids.length,
altText: flex.altText,
channelId: p.channelId || ''
},
'submitted'
);

recordUsage_('flex_recipients_attempted', ids.length, {
source: 'selected_friends_flex'
});

return {
ok: true,
recipientCount: ids.length,
recipientIds: ids,
altText: flex.altText,
result: result
};
}

function getFriendDisplayName_(userId) {
var existing = findRecordByField_('Friends', 'userId', userId);

return existing && existing.record.displayName
? String(existing.record.displayName)
: '';
}

function previewFlex_(payload) {
var flex = getFlexContents_(payload || {});

return {
ok: true,
altText: flex.altText,
contents: flex.contents
};
}

/* ==========================================================================
N. REPLY AND LOADING INDICATOR
• ========================================================================== */

function sendReplyToken_(replyToken, messages, channelId) {
if (!replyToken) throw new Error('replyToken is required');

var list = Array.isArray(messages) ? messages : [messages];

if (!list.length) throw new Error('At least one message is required');

return lineApi_(
'/v2/bot/message/reply',
'post',
{
replyToken: replyToken,
messages: list.slice(0, 5)
},
channelId
);
}

function startLoading_(payload) {
var p = payload || {};
var chatId = String(p.chatId || p.userId || '').trim();

if (!chatId) throw new Error('chatId is required');

var seconds = Math.max(5, Math.min(Number(p.loadingSeconds || 20), 60));

return lineApi_(
'/v2/bot/chat/loading/start',
'post',
{
chatId: chatId,
loadingSeconds: seconds
},
p.channelId
);
}

/* ==========================================================================
O. FLEX TEMPLATE STUDIO
• ========================================================================== */

function createDefaultTemplates_() {
var defaults = [
{
name: 'Information Card',
description: 'การ์ดข้อมูลทั่วไป',
altText: 'ข้อมูลจาก LINE',
category: 'general',
enabled: true,
contents: {
type: 'bubble',
body: {
type: 'box',
layout: 'vertical',
contents: [
{
type: 'text',
text: 'หัวข้อข้อมูล',
weight: 'bold',
size: 'xl',
wrap: true
},
{
type: 'text',
text: 'รายละเอียดของคุณ',
wrap: true,
margin: 'md'
}
 ]
}
}
},
{
name: 'Contact Support Card',
description: 'การ์ดติดต่อเจ้าหน้าที่',
altText: 'ติดต่อเจ้าหน้าที่',
category: 'support',
enabled: true,
contents: {
type: 'bubble',
body: {
type: 'box',
layout: 'vertical',
contents: [
{
type: 'text',
text: 'ต้องการความช่วยเหลือ?',
size: 'lg',
weight: 'bold',
wrap: true
},
{
type: 'text',
text: 'พิมพ์คำว่า เจ้าหน้าที่ เพื่อขอคุยกับทีมงาน',
size: 'sm',
wrap: true,
margin: 'md'
}
 ]
}
}
}
];

var current = listRecords_('FlexTemplates', { limit: 1000 });
var created = [];

defaults.forEach(function(item) {
var exists = current.some(function(old) {
return String(old.name || '') === item.name;
});

if (!exists) {
created.push(saveRecord_('FlexTemplates', item));
}
});

return {
ok: true,
createdCount: created.length,
created: created
};
}

/* ==========================================================================
P. WELCOME FLOW
• ========================================================================== */

function sendWelcomeTest_(payload) {
var p = payload || {};
var flowResult = getRecordById_('WelcomeFlow', p.id);

if (!flowResult) throw new Error('Welcome flow not found');

var flow = flowResult.record;
var userId = String(p.userId || '');

if (!userId) throw new Error('userId is required for welcome test');

if (String(flow.messageType || 'text') === 'flex') {
return sendFlex_({
userId: userId,
channelId: p.channelId,
altText: flow.text || flow.name || 'Welcome',
contents: flow.messageJson
});
}

return sendText_({
userId: userId,
channelId: p.channelId,
text: flow.text || ''
});
}

function sendWelcomeFlow_(userId, replyToken, channelId) {
var flows = listRecords_('WelcomeFlow', {
enabled: true,
limit: 500
}).filter(function(item) {
return String(item.triggerType || 'follow').toLowerCase() === 'follow';
}).sort(function(a, b) {
return Number(a.priority || 0) - Number(b.priority || 0);
});

if (!flows.length) {
if (replyToken) {
return sendReplyToken_(replyToken, {
type: 'text',
text: 'สวัสดีครับ/ค่ะ ยินดีต้อนรับ'
}, channelId);
}

return { sent: false, reason: 'No welcome flow configured' };
}

var flow = flows[0];

if (String(flow.messageType || 'text').toLowerCase() === 'flex') {
return sendReplyToken_(replyToken, {
type: 'flex',
altText: String(flow.text || flow.name || 'Welcome').substring(0, 400),
contents: parseJsonObject_(flow.messageJson, 'Welcome Flex contents')
}, channelId);
}

return sendReplyToken_(replyToken, {
type: 'text',
text: String(flow.text || 'สวัสดีครับ/ค่ะ ยินดีต้อนรับ')
.substring(0, APP.MAX_TEXT_LENGTH)
}, channelId);
}

/* ==========================================================================
Q. GOOGLE GEMINI AND AI PROFILES
• ========================================================================== */

/**
• Resolves a Gemini model name.
• If an old AI Profile still contains a non-Gemini model name, ignore it and
• use GEMINI_MODEL instead so existing profiles do not break after migration.
*/
function getGeminiModel_(requestedModel) {
var configured = PropertiesService.getScriptProperties()
.getProperty('GEMINI_MODEL') || APP.DEFAULT_GEMINI_MODEL;
var requested = String(requestedModel || '').trim();

return requested.indexOf('gemini-') === 0 ? requested : configured;
}

/**
• Calls the Gemini generateContent REST API.
• Converts the existing chat-style messages array used by this app into
• Gemini systemInstruction + contents, preserving existing callers.
*/
function callGemini_(messages, options) {
var props = PropertiesService.getScriptProperties();
var apiKey = props.getProperty('GEMINI_API_KEY');

if (!apiKey) {
throw new Error('GEMINI_API_KEY is not configured in Script Properties');
}

var p = options || {};
var model = getGeminiModel_(p.model);
var sourceMessages = Array.isArray(messages) ? messages : [];
var systemTexts = [];
var contents = [];

sourceMessages.forEach(function(message) {
if (!message) return;
var role = String(message.role || 'user').toLowerCase();
var value = message.content;
var textValue;
var geminiParts = [];

if (Array.isArray(value)) {
value.forEach(function(part) {
if (typeof part === 'string') {
if (part) geminiParts.push({ text: part });
return;
}
if (!part || typeof part !== 'object') return;
if (part.inlineData && part.inlineData.data && part.inlineData.mimeType) {
geminiParts.push({
inlineData: {
mimeType: String(part.inlineData.mimeType),
data: String(part.inlineData.data)
}
});
} else if (typeof part.text === 'string' && part.text) {
geminiParts.push({ text: part.text });
}
});
textValue = geminiParts.filter(function(part) { return Boolean(part.text); })
.map(function(part) { return part.text; }).join('\n');
} else {
textValue = String(value === undefined || value === null ? '' : value);
if (textValue) geminiParts.push({ text: textValue });
}

if (!textValue && !geminiParts.some(function(part) { return Boolean(part.inlineData); })) return;

if (role === 'system' || role === 'developer') {
systemTexts.push(textValue);
return;
}

contents.push({
role: role === 'assistant' ? 'model' : 'user',
parts: geminiParts.length ? geminiParts : [{ text: textValue }]
});
});

if (!contents.length) {
throw new Error('Gemini request has no user message');
}

var body = {
contents: contents,
generationConfig: {
temperature: p.temperature === undefined ? 0.4 : Number(p.temperature),
maxOutputTokens: Math.max(
50,
Math.min(Number(p.maxTokens || APP.DEFAULT_AI_TOKENS), 4000)
)
}
};

if (systemTexts.length) {
body.systemInstruction = {
parts: [{ text: systemTexts.join('\n\n') }]
};
}

var url = APP.GEMINI_BASE_ENDPOINT + encodeURIComponent(model) + ':generateContent';
var response = UrlFetchApp.fetch(url, {
method: 'post',
contentType: 'application/json',
headers: {
'x-goog-api-key': apiKey
},
payload: JSON.stringify(body),
muteHttpExceptions: true
});

var code = response.getResponseCode();
var responseText = response.getContentText();
var data = {};

try {
data = JSON.parse(responseText);
} catch (err) {
throw new Error('Gemini returned invalid JSON (HTTP ' + code + ')');
}

if (code < 200 || code >= 300) {
var message = data.error && data.error.message
? data.error.message
: responseText;

logSystem_('ERROR', 'callGemini_', 'Gemini API error', {
httpCode: code,
model: model,
message: String(message).substring(0, 1500)
});

throw new Error('Gemini API error (' + code + '): ' + message);
}

var candidate = data.candidates && data.candidates.length
? data.candidates[0]
: null;
var parts = candidate && candidate.content && candidate.content.parts
? candidate.content.parts
: [];
var answerText = parts.map(function(part) {
return part && typeof part.text === 'string' ? part.text : '';
}).filter(Boolean).join('\n');

if (!answerText) {
var finishReason = candidate && candidate.finishReason
? candidate.finishReason
: '';
var blockReason = data.promptFeedback && data.promptFeedback.blockReason
? data.promptFeedback.blockReason
: '';
throw new Error(
'Gemini returned no text' +
(finishReason ? ' (finishReason: ' + finishReason + ')' : '') +
(blockReason ? ' (blockReason: ' + blockReason + ')' : '')
);
}

var usage = data.usageMetadata || {};

return {
text: answerText,
model: data.modelVersion || model,
usage: {
promptTokenCount: Number(usage.promptTokenCount || 0),
candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
totalTokenCount: Number(usage.totalTokenCount || 0)
}
};
}

function getPrompt_(promptId) {
if (promptId) {
var byId = getRecordById_('Prompts', promptId);
if (byId) return byId.record;
}

var defaultName = String(getSetting_('default_prompt_name', 'default'));
var prompts = listRecords_('Prompts', { limit: 500 });

var active = prompts.filter(function(item) {
return toBoolean_(item.active);
});

return active.find(function(item) {
return String(item.name || '').toLowerCase() ===
defaultName.toLowerCase();
}) || active[0] || null;
}

function getAIProfile_(profileId) {
if (profileId) {
var explicit = getRecordById_('AIProfiles', profileId);
if (explicit) return explicit.record;
}

var defaultId = getSetting_('default_ai_profile', '');

if (defaultId) {
var defaultProfile = getRecordById_('AIProfiles', defaultId);
if (defaultProfile) return defaultProfile.record;
}

return listRecords_('AIProfiles', { limit: 100 }).find(function(item) {
return toBoolean_(item.enabled);
}) || null;
}

function testAI_(payload) {
var p = payload || {};
var text = String(
p.prompt || 'ทดสอบระบบ AI กรุณาตอบว่าเชื่อมต่อสำเร็จ'
);

var result = callGemini_([
{
role: 'system',
content: 'คุณเป็นผู้ช่วยทดสอบระบบ ตอบภาษาไทยอย่างกระชับ'
},
{
role: 'user',
content: text
}
 ], {
model: p.model || getGeminiModel_(),
temperature: 0.2,
maxTokens: 200
});

return {
ok: true,
model: result.model,
text: result.text,
usage: result.usage
};
}

function previewAI_(payload) {
var p = payload || {};
var text = String(p.text || p.message || '').trim();

if (!text) throw new Error('text is required');

var answer = generateAIReply_(text, {
profileId: p.profileId || '',
promptId: p.promptId || '',
includeKnowledge: p.includeKnowledge !== false
});

return {
ok: true,
input: text,
answer: answer.text,
model: answer.model,
knowledgeUsed: answer.knowledgeUsed
};
}

function generateAIReply_(userText, options) {
var opts = options || {};

if (!getSettingBoolean_('ai_enabled', true)) {
return {
text: 'ขออภัย ขณะนี้ระบบตอบกลับอัตโนมัติปิดให้บริการชั่วคราว',
model: '',
knowledgeUsed: []
};
}

var profile = getAIProfile_(opts.profileId);
var prompt = getPrompt_(opts.promptId);

var knowledge = opts.includeKnowledge === false
? []
: searchKnowledge_(userText, 5);

var systemParts = [];

if (profile && profile.systemPrompt) {
systemParts.push(String(profile.systemPrompt));
} else if (prompt && prompt.content) {
systemParts.push(String(prompt.content));
} else {
systemParts.push(
'คุณเป็นผู้ช่วย LINE ตอบภาษาไทยอย่างสุภาพ กระชับ และไม่สร้างข้อมูล'
);
}

if (knowledge.length) {
systemParts.push(
'ข้อมูลอ้างอิงจาก Knowledge Base:\n\n' +
knowledge.map(function(item, index) {
return '[' + (index + 1) + '] ' +
item.title + '\n' + item.content;
}).join('\n\n')
);
}

systemParts.push(
'อย่าเปิดเผย API keys, access tokens, passwords หรือข้อมูลลับ'
);

systemParts.push(
'หากไม่ทราบคำตอบ ให้บอกตามจริงและเสนอให้ติดต่อเจ้าหน้าที่'
);

var userPrompt = String(userText || '').substring(0, 12000);
var userContent;

if (opts.image && opts.image.data && opts.image.mimeType) {
userPrompt = userPrompt || 'ลูกค้าส่งรูปภาพมาให้ กรุณาอ่านข้อความในภาพและวิเคราะห์สิ่งที่มองเห็นอย่างละเอียด ตอบเป็นภาษาไทยอย่างสุภาพ แยกสิ่งที่เห็นจริงออกจากข้อสันนิษฐาน และห้ามเดาข้อมูลที่อ่านไม่ชัด';
userContent = [
{ text: userPrompt },
{ inlineData: {
mimeType: String(opts.image.mimeType),
data: String(opts.image.data)
} }
];
systemParts.push(
'ลูกค้าอาจส่งภาพมาให้วิเคราะห์ ให้อ่านข้อความที่มองเห็นและอธิบายเนื้อหาภาพตามหลักฐานในภาพเท่านั้น หากภาพเบลอ ข้อความไม่ชัด หรือข้อมูลไม่ครบ ให้บอกข้อจำกัดอย่างตรงไปตรงมา ห้ามแต่งตัวเลข ชื่อบุคคล หรือรายละเอียดที่อ่านไม่ได้'
);
} else {
userContent = userPrompt;
}

var result = callGemini_([
{
role: 'system',
content: systemParts.join('\n\n')
},
{
role: 'user',
content: userContent
}
 ], {
model: profile && profile.model
? profile.model
: getGeminiModel_(),
temperature: profile && profile.temperature !== ''
? Number(profile.temperature)
: 0.4,
maxTokens: profile && profile.maxOutputTokens
? Number(profile.maxOutputTokens)
: APP.DEFAULT_AI_TOKENS
});

var answer = String(result.text || '').trim();
var blocked = String(getSetting_('safety_blocked_terms', ''))
.split(',')
.map(function(item) {
return item.trim().toLowerCase();
})
.filter(Boolean);

if (blocked.some(function(term) {
return answer.toLowerCase().indexOf(term) >= 0;
})) {
answer =
'ขออภัย ข้อความนี้ไม่สามารถตอบกลับอัตโนมัติได้ กรุณาติดต่อเจ้าหน้าที่';
}

var maxChars = Math.max(
100,
Number(getSetting_('safety_max_reply_chars', '4000'))
);

if (answer.length > maxChars) answer = answer.substring(0, maxChars);

recordUsage_('gemini_requests', 1, {
model: result.model
});

return {
text: answer,
model: result.model,
knowledgeUsed: knowledge.map(function(item) {
return {
id: item.id,
title: item.title
};
})
};
}

/* ==========================================================================
R. KNOWLEDGE BASE / BASIC RAG
• ========================================================================== */

/**
• This implementation is keyword retrieval, not vector-embedding search.
*/
function searchKnowledge_(query, maxResults) {
if (!getSettingBoolean_('knowledge_enabled', true)) return [];

var words = normalizeWords_(String(query || ''));
var records = listRecords_('KnowledgeBase', {
enabled: true,
limit: APP.MAX_LIST_ROWS
});

var scored = records.map(function(item) {
var title = normalizeWords_(item.title || '');
var keywords = normalizeWords_(item.keywords || '');
var content = normalizeWords_(item.content || '');

var score = 0;

words.forEach(function(word) {
if (title.indexOf(word) >= 0) score += 5;
if (keywords.indexOf(word) >= 0) score += 4;
if (content.indexOf(word) >= 0) score += 1;
});

score += Number(item.priority || 0) * 0.1;

return {
id: item.id,
title: item.title || '',
content: String(item.content || '').substring(0, 5000),
score: score
};
}).filter(function(item) {
return item.score > 0;
});

scored.sort(function(a, b) {
return b.score - a.score;
});

return scored.slice(0, Math.max(1, Number(maxResults || 5)));
}

function createKnowledgeDocument_(payload) {
var p = payload || {};

if (!p.title || !p.content) {
throw new Error('title and content are required');
}

var knowledge = saveRecord_('KnowledgeBase', {
title: String(p.title),
content: String(p.content),
keywords: String(p.keywords || ''),
category: String(p.category || 'general'),
enabled: p.enabled === undefined ? true : toBoolean_(p.enabled),
priority: Number(p.priority || 0),
source: String(p.source || 'manual')
});

var document = saveRecord_('Documents', {
title: String(p.title),
content: String(p.content),
source: String(p.source || 'manual'),
mimeType: String(p.mimeType || 'text/plain'),
status: 'indexed',
metadata: {
knowledgeBaseId: knowledge.id
}
});

return {
knowledgeBase: knowledge,
document: document
};
}

function rebuildKnowledge_() {
var docs = listRecords_('Documents', { limit: APP.MAX_LIST_ROWS });
var added = 0;

docs.forEach(function(doc) {
if (String(doc.status || '').toLowerCase() !== 'indexed') return;

var match = listRecords_('KnowledgeBase', {
search: String(doc.title || ''),
limit: 100
}).some(function(item) {
return String(item.title || '') === String(doc.title || '');
});

if (!match) {
saveRecord_('KnowledgeBase', {
title: doc.title,
content: doc.content,
keywords: '',
category: 'document',
enabled: true,
priority: 0,
source: doc.source || ''
});

added++;
}
});

return {
ok: true,
indexed: added,
totalDocuments: docs.length,
retrievalMode: 'keyword-based'
};
}

/* ==========================================================================
S. PROMPT VERSIONING
• ========================================================================== */

function savePromptVersion_(payload) {
var p = payload || {};
var promptId = String(p.promptId || p.id || '');

if (!promptId) throw new Error('promptId is required');

var existing = getRecordById_('Prompts', promptId);

if (!existing) throw new Error('Prompt not found');

var prompt = existing.record;
var oldVersion = Number(prompt.version || 1);
var nextVersion = oldVersion + 1;

saveRecord_('PromptVersions', {
promptId: prompt.id,
promptName: prompt.name,
version: oldVersion,
content: prompt.content || '',
note: String(p.note || 'Saved before prompt update'),
createdBy: String(p.createdBy || 'admin')
});

var updated = saveRecord_('Prompts', {
id: prompt.id,
name: p.name !== undefined ? p.name : prompt.name,
content: p.content !== undefined ? p.content : prompt.content,
active: p.active !== undefined ? p.active : prompt.active,
version: nextVersion,
description: p.description !== undefined
? p.description
: prompt.description
});

return {
prompt: updated,
version: nextVersion
};
}

/* ==========================================================================
T. AUTOMATION RULES
• ========================================================================== */

function executeAutomation_(context) {
var ctx = context || {};
var triggerType = String(ctx.triggerType || '').toLowerCase();
var keyword = String(ctx.keyword || '').toLowerCase().trim();

var rules = listRecords_('AutomationRules', {
enabled: true,
limit: 1000
}).sort(function(a, b) {
return Number(a.priority || 0) - Number(b.priority || 0);
});

var rule = rules.find(function(item) {
var type = String(item.triggerType || 'keyword').toLowerCase();
var pattern = String(item.keyword || '').toLowerCase().trim();

if (type !== triggerType && type !== 'all') return false;
if (!pattern || pattern === '*') return true;

return keyword.indexOf(pattern) >= 0;
});

if (!rule) return false;

var action = String(rule.actionType || '').toLowerCase();
var value = String(rule.actionValue || '');

if (action === 'reply' || action === 'sendtext') {
if (ctx.replyToken) {
sendReplyToken_(ctx.replyToken, {
type: 'text',
text: value.substring(0, APP.MAX_TEXT_LENGTH)
}, ctx.channelId);
} else if (ctx.userId) {
sendText_({
userId: ctx.userId,
text: value,
channelId: ctx.channelId,
source: 'automation'
});
}
} else if (action === 'handover') {
createHandover_(ctx.userId, ctx.displayName || '', keyword);

if (ctx.replyToken) {
sendReplyToken_(ctx.replyToken, {
type: 'text',
text: value || 'กำลังส่งต่อให้เจ้าหน้าที่ครับ/ค่ะ'
}, ctx.channelId);
}
} else if (action === 'disableai') {
setFriendAI_({
userId: ctx.userId,
enabled: false
});
} else if (action === 'enableai') {
setFriendAI_({
userId: ctx.userId,
enabled: true
});
} else if (action === 'addtag') {
changeFriendTag_({
userId: ctx.userId,
tag: value
}, true);
} else if (action === 'flex') {
var template = getRecordById_('FlexTemplates', value);

if (template && ctx.replyToken) {
sendReplyToken_(ctx.replyToken, {
type: 'flex',
altText: String(
template.record.altText || template.record.name || 'Flex message'
).substring(0, 400),
contents: parseJsonObject_(
template.record.contents,
'Flex template contents'
)
}, ctx.channelId);
}
}

logAdmin_(
'automation_triggered',
'AutomationRules',
rule.id,
{
triggerType: triggerType,
actionType: action,
userId: ctx.userId || ''
},
'success'
);

return true;
}

function shouldHandover_(text) {
var terms = String(
getSetting_('auto_handover_keywords', 'เจ้าหน้าที่,แอดมิน,พนักงาน')
).split(',').map(function(item) {
return item.trim().toLowerCase();
}).filter(Boolean);

var value = String(text || '').toLowerCase();

return terms.some(function(term) {
return value.indexOf(term) >= 0;
});
}

/* ==========================================================================
U. LINE WEBHOOK PROCESSING
• ========================================================================== */

/**
• This method expects Worker to have verified the raw X-Line-Signature.
• Worker should acknowledge LINE quickly and forward this job asynchronously
• when practical, to reduce webhook timeouts.
*/
function processLineWebhook_(body) {
var input = body || {};
var events = Array.isArray(input.events) ? input.events : [];
var results = [];

if (!events.length) {
return { received: 0, processed: 0, results: [] };
}

events.forEach(function(event) {
var eventId = String(event && event.webhookEventId || '');
try {
var result = processLineEvent_(event, input.destination || '');
if (eventId && !(result && result.pending)) {
updateWebhookEventStatus_(eventId, result && result.ok === false ? 'error' : 'processed', result && result.error ? result.error : '', event);
}
results.push(result);
} catch (err) {
logError_('processLineEvent_', err);
updateWebhookEventStatus_(eventId, 'error', safeError_(err), event);
results.push({ ok: false, error: safeError_(err), webhookEventId: eventId });
}
});

return { received: events.length, processed: results.length, results: results };
}

function processLineEvent_(event, destination) {
if (!event || !event.type) {
return {
ok: false,
error: 'Invalid event'
};
}

var eventId = String(event.webhookEventId || '');
var priorWebhook = eventId ? findRecordByField_('WebhookEvents', 'webhookEventId', eventId) : null;
var priorStatus = priorWebhook ? String(priorWebhook.record.status || '').toLowerCase() : '';

if (eventId && (priorStatus === 'processed' || priorStatus === 'ignored' || priorStatus === 'success')) {
return { ok: true, duplicate: true, webhookEventId: eventId };
}

if (eventId && (priorStatus === 'processing' || priorStatus === 'received')) {
var priorTime = Date.parse(String(priorWebhook.record.timestamp || ''));
if (priorTime && Date.now() - priorTime < 60000) {
return { ok: true, duplicate: true, pending: true, webhookEventId: eventId };
}
}

if (String(event.mode || '') === 'standby') {
return { ok: true, ignored: true, reason: 'standby mode' };
}

var userId = getEventUserId_(event);
var channelId = resolveChannelIdFromDestination_(destination);

saveRecord_('WebhookEvents', {
id: priorWebhook ? priorWebhook.record.id : '',
timestamp: nowIso_(),
eventType: event.type,
userId: userId,
webhookEventId: eventId,
status: 'processing',
payload: event,
error: ''
});

if (event.type === 'follow') {
return processFollowEvent_(event, userId, channelId);
}

if (event.type === 'unfollow') {
var oldFriend = findRecordByField_('Friends', 'userId', userId);

if (oldFriend) {
saveRecord_('Friends', {
id: oldFriend.record.id,
userId: userId,
status: 'blocked',
lastSeenAt: nowIso_()
});
}

return {
ok: true,
eventType: 'unfollow'
};
}

if (event.type === 'message') {
return processMessageEvent_(event, userId, channelId);
}

if (event.type === 'postback') {
var postback = event.postback || {};

var handled = executeAutomation_({
triggerType: 'postback',
keyword: String(postback.data || ''),
userId: userId,
replyToken: event.replyToken,
channelId: channelId
});

return {
ok: true,
eventType: 'postback',
handledBy: handled ? 'automation' : 'none'
};
}

return {
ok: true,
eventType: event.type,
ignored: true
};
}

function isWebhookDuplicate_(webhookEventId) {
if (!webhookEventId) return false;
var existing = findRecordByField_('WebhookEvents', 'webhookEventId', webhookEventId);
if (!existing) return false;
var status = String(existing.record.status || '').toLowerCase();
return status === 'processed' || status === 'success' || status === 'ignored';
}

/** Update the existing event row so failed queue deliveries can be retried safely. */
function updateWebhookEventStatus_(webhookEventId, status, errorText, event) {
try {
var existing = webhookEventId
? findRecordByField_('WebhookEvents', 'webhookEventId', webhookEventId)
: null;
var record = {
status: String(status || 'error'),
error: String(errorText || '').substring(0, 2000)
};
if (existing) {
record.id = existing.record.id;
saveRecord_('WebhookEvents', record);
return;
}
if (event) {
saveRecord_('WebhookEvents', {
timestamp: nowIso_(),
eventType: event.type || 'unknown',
userId: getEventUserId_(event),
webhookEventId: webhookEventId || '',
status: record.status,
payload: event,
error: record.error
});
}
} catch (statusError) {
logSystem_('ERROR', 'updateWebhookEventStatus_', safeError_(statusError), {
webhookEventId: webhookEventId || '', status: status || ''
});
}
}

function getEventUserId_(event) {
if (!event || !event.source) return '';

return String(
event.source.userId ||
event.source.groupId ||
event.source.roomId ||
''
);
}

function processFollowEvent_(event, userId, channelId) {
if (!userId) return { ok: true, eventType: 'follow' };

var profile = getLineProfile_(userId, channelId);

upsertFriend_(userId, {
displayName: profile && profile.displayName ? profile.displayName : '',
pictureUrl: profile && profile.pictureUrl ? profile.pictureUrl : '',
statusMessage: profile && profile.statusMessage
? profile.statusMessage
: '',
language: profile && profile.language ? profile.language : '',
status: 'active',
aiEnabled: true,
lastSeenAt: nowIso_()
});

getOrCreateSession_(
userId,
profile && profile.displayName ? profile.displayName : ''
);

if (getSettingBoolean_('welcome_enabled', true) && event.replyToken) {
sendWelcomeFlow_(userId, event.replyToken, channelId);
}

return {
ok: true,
eventType: 'follow',
userId: userId
};
}

/**
• Downloads a LINE image message and converts it to Gemini inline image data.
• LINE message content must be fetched promptly because LINE does not retain it forever.
*/
function getLineImageForGemini_(messageId, channelId) {
if (!messageId) throw new Error('Image messageId is required');
var token = getChannelToken_(channelId);
var url = APP.LINE_DATA_ENDPOINT + '/v2/bot/message/' + encodeURIComponent(messageId) + '/content';
var response = UrlFetchApp.fetch(url, {
method: 'get',
headers: { Authorization: 'Bearer ' + token },
muteHttpExceptions: true
});
var code = response.getResponseCode();
if (code < 200 || code >= 300) {
var detail = '';
try { detail = response.getContentText(); } catch (ignore) {}
throw new Error('LINE image download failed (HTTP ' + code + '): ' + String(detail).substring(0, 500));
}
var blob = response.getBlob();
var bytes = blob.getBytes();
if (!bytes || !bytes.length) throw new Error('LINE returned an empty image');
// Keep inline requests modest to reduce Apps Script memory use and Gemini request failures.
if (bytes.length > 8 * 1024 * 1024) {
throw new Error('Image is larger than 8 MB; please ask the customer to send a smaller image');
}
var headers = response.getHeaders() || {};
var mimeType = String(headers['Content-Type'] || headers['content-type'] || blob.getContentType() || 'image/jpeg').split(';')[0].trim().toLowerCase();
var allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
if (allowed.indexOf(mimeType) < 0) mimeType = 'image/jpeg';
return { mimeType: mimeType, data: Utilities.base64Encode(bytes), sizeBytes: bytes.length };
}

function processMessageEvent_(event, userId, channelId) {
if (!userId) return { ok: false, error: 'Missing userId' };

var message = event.message || {};
var isImage = message.type === 'image';
var isText = message.type === 'text';
var text = isText ? String(message.text || '').trim() : '';
var messageTextForLog = isImage ? '[ลูกค้าส่งรูปภาพ]' : text;

/*
• Start the LINE loading animation before profile lookups, Sheet writes,
• automation checks, and Gemini generation. The Worker may already have
• started it to reduce latency; in that case, avoid a duplicate call.
*/
if (
(isText || isImage) &&
event && event.source && event.source.type === 'user' &&
event.lineLoadingStartedByWorker !== true
) {
try {
startLoading_({
chatId: userId,
channelId: channelId,
loadingSeconds: 60
});
} catch (loadingError) {
logSystem_('WARN', 'processMessageEvent_', 'Early loading animation failed', {
error: safeError_(loadingError)
});
}
}

var profile = getLineProfile_(userId, channelId);
var displayName = profile && profile.displayName
? profile.displayName
: '';

upsertFriend_(userId, {
displayName: displayName,
pictureUrl: profile && profile.pictureUrl ? profile.pictureUrl : '',
statusMessage: profile && profile.statusMessage
? profile.statusMessage
: '',
language: profile && profile.language ? profile.language : '',
status: 'active',
lastSeenAt: nowIso_()
});

getOrCreateSession_(userId, displayName);

if (!isText && !isImage) {
logChat_({
userId: userId,
displayName: displayName,
direction: 'inbound',
messageType: message.type || 'unknown',
text: '',
messageJson: message,
source: 'line_webhook',
status: 'received',
channelId: channelId
});
incrementUnread_(userId);
return {
ok: true,
messageType: message.type || 'unknown',
ignored: true
};
}

logChat_({
userId: userId,
displayName: displayName,
direction: 'inbound',
messageType: isImage ? 'image' : 'text',
text: messageTextForLog,
messageJson: message,
source: 'line_webhook',
status: 'received',
channelId: channelId
});

updateFriendLastMessage_(userId, messageTextForLog);
incrementUnread_(userId);
recordUsage_(isImage ? 'incoming_image_messages' : 'incoming_text_messages', 1, {});

/* Keep a conversation in human mode while its handover queue is open. */
var activeHandover = listRecords_('HandoverQueue', {
limit: 1000,
field: 'userId',
value: userId
}).find(function(item) {
return String(item.status || '').toLowerCase() !== 'closed';
});

if (activeHandover) {
return {
ok: true,
handledBy: 'handover_waiting',
loadingStarted: true
};
}

if (isText && executeAutomation_({
triggerType: 'keyword',
keyword: text,
userId: userId,
displayName: displayName,
replyToken: event.replyToken,
channelId: channelId
})) {
return {
ok: true,
handledBy: 'automation'
};
}

if (isText && shouldHandover_(text)) {
createHandover_(userId, displayName, text);

if (event.replyToken) {
sendReplyToken_(event.replyToken, {
type: 'text',
text: 'รับทราบครับ/ค่ะ กำลังส่งต่อให้เจ้าหน้าที่ กรุณารอสักครู่'
}, channelId);
}

return {
ok: true,
handledBy: 'handover'
};
}

var friend = findRecordByField_('Friends', 'userId', userId);
var session = findRecordByField_('ChatSessions', 'userId', userId);

var aiAllowed = getSettingBoolean_('ai_enabled', true) &&
(!friend || toBoolean_(friend.record.aiEnabled) !== false) &&
(!session || toBoolean_(session.record.aiEnabled) !== false);

if (!aiAllowed) {
return {
ok: true,
handledBy: 'manual_mode'
};
}

var imageForAI = null;
if (isImage) {
try {
imageForAI = getLineImageForGemini_(message.id, channelId);
} catch (imageError) {
logError_('getLineImageForGemini_', imageError);
var imageFailureText = 'ขออภัยครับ/ค่ะ ขณะนี้ระบบอ่านรูปภาพนี้ไม่สำเร็จ กรุณาส่งภาพอีกครั้งโดยให้ภาพชัดเจนและมีขนาดไม่เกิน 8 MB';
if (event.replyToken) {
try {
sendReplyToken_(event.replyToken, { type: 'text', text: imageFailureText }, channelId);
} catch (replyImageError) {
if (event.source && event.source.type === 'user') {
lineApi_('/v2/bot/message/push', 'post', { to: userId, messages: [{ type: 'text', text: imageFailureText }] }, channelId);
} else {
throw replyImageError;
}
}
logChat_({
userId: userId, displayName: displayName, direction: 'outbound',
messageType: 'text', text: imageFailureText, source: 'ai', status: 'sent', channelId: channelId
});
}
return { ok: true, handledBy: 'image_error', error: safeError_(imageError), customerNotified: true };
}
}

var generated;
try {
generated = generateAIReply_(isImage ? (text || 'ช่วยอ่านข้อความและวิเคราะห์รูปภาพที่ลูกค้าส่งมา') : text, {
userId: userId,
includeKnowledge: true,
image: imageForAI
});
} catch (aiError) {
logError_('generateAIReply_(' + (isImage ? 'image' : 'text') + ')', aiError);
var aiFailureText = isImage
? 'ขออภัยครับ/ค่ะ ระบบวิเคราะห์รูปภาพขัดข้องชั่วคราว กรุณาลองส่งภาพอีกครั้งในอีกสักครู่'
: 'ขออภัยครับ/ค่ะ ขณะนี้ระบบตอบกลับขัดข้องชั่วคราว กรุณาลองส่งข้อความอีกครั้งในอีกสักครู่';
try {
if (event.replyToken) {
sendReplyToken_(event.replyToken, { type: 'text', text: aiFailureText }, channelId);
} else if (event.source && event.source.type === 'user') {
lineApi_('/v2/bot/message/push', 'post', { to: userId, messages: [{ type: 'text', text: aiFailureText }] }, channelId);
}
} catch (sendFailureError) {
try {
if (event.source && event.source.type === 'user') {
lineApi_('/v2/bot/message/push', 'post', { to: userId, messages: [{ type: 'text', text: aiFailureText }] }, channelId);
}
} catch (pushFailureError) {
logError_('AI failure notification', pushFailureError);
}
}
logChat_({
userId: userId, displayName: displayName, direction: 'outbound',
messageType: 'text', text: aiFailureText, source: 'system', status: 'failed', channelId: channelId
});
return { ok: true, handledBy: 'ai_error', error: safeError_(aiError), customerNotified: true };
}

if (event.replyToken) {
var replyMessage = {
type: 'text',
text: generated.text.substring(0, APP.MAX_TEXT_LENGTH)
};
try {
sendReplyToken_(event.replyToken, replyMessage, channelId);
} catch (replyError) {
// Asynchronous Worker processing can outlast LINE's short reply-token window.
// For one-to-one user chats, fall back to push for both text and image replies.
if (!event.source || event.source.type !== 'user') throw replyError;
logSystem_('WARN', 'processMessageEvent_', 'Reply token failed; trying push message', {
error: safeError_(replyError), userId: userId, messageType: isImage ? 'image' : 'text'
});
lineApi_('/v2/bot/message/push', 'post', {
to: userId,
messages: [replyMessage]
}, channelId);
}

logChat_({
userId: userId,
displayName: displayName,
direction: 'outbound',
messageType: 'text',
text: generated.text,
source: 'ai',
status: 'sent',
channelId: channelId
});
}

incrementSession_(userId, {
lastMessage: generated.text.substring(0, 500),
lastMessageAt: nowIso_()
});

return {
ok: true,
handledBy: 'ai'
};
}

/* ==========================================================================
V. CAMPAIGNS AND BROADCASTS
• ========================================================================== */

/**
• Queue the campaign for scheduled processing.
*/
function sendCampaignNow_(payload) {
var p = payload || {};
var id = String(p.id || p.campaignId || '');

if (!id) throw new Error('campaignId is required');

var result = getRecordById_('Campaigns', id);

if (!result) throw new Error('Campaign not found');

var campaign = result.record;
var status = String(campaign.status || '').toLowerCase();

if (status === 'sent' || status === 'cancelled') {
throw new Error('Campaign is already ' + status);
}

var updated = saveRecord_('Campaigns', {
id: campaign.id,
status: 'queued',
sentCount: 0,
lastError: ''
});

return {
ok: true,
campaign: updated,
message: 'Campaign queued; install the scheduled trigger to process batches.'
};
}

function getCampaignRecipients_(campaign) {
var type = String(campaign.targetType || 'all').toLowerCase();

if (type === 'selected') {
var ids = parseJsonArray_(campaign.selectedUserIds || []);

var friendsById = {};

listRecords_('Friends', { limit: APP.MAX_LIST_ROWS }).forEach(function(row) {
friendsById[String(row.userId)] = row;
});

return ids.map(function(userId) {
return friendsById[String(userId)] || {
userId: String(userId),
displayName: ''
};
}).filter(function(item) {
return Boolean(item.userId);
});
}

var friends = listRecords_('Friends', {
limit: APP.MAX_LIST_ROWS
});

if (type === 'tag') {
var targetTags = parseTags_(campaign.targetTags);

friends = friends.filter(function(friend) {
var tags = parseTags_(friend.tags);

return targetTags.some(function(tag) {
return tags.indexOf(tag) >= 0;
});
});
} else if (type === 'active') {
friends = friends.filter(function(friend) {
return String(friend.status || '').toLowerCase() === 'active';
});
}

return friends.filter(function(friend) {
return friend.userId &&
String(friend.status || '').toLowerCase() !== 'blocked';
});
}

function buildCampaignMessage_(campaign) {
var type = String(campaign.messageType || 'text').toLowerCase();

if (type === 'flex') {
return {
type: 'flex',
altText: String(campaign.text || campaign.name || 'Broadcast')
.substring(0, 400),
contents: parseJsonObject_(
campaign.messageJson,
'Campaign Flex contents'
)
};
}

return {
type: 'text',
text: String(campaign.text || '').substring(0, APP.MAX_TEXT_LENGTH)
};
}

function runScheduledCampaigns_() {
var campaigns = listRecords_('Campaigns', { limit: 1000 });
var now = new Date();
var results = [];

campaigns.forEach(function(campaign) {
var status = String(campaign.status || '').toLowerCase();

if (status !== 'queued' && status !== 'sending' && status !== 'scheduled') {
return;
}

if (status === 'scheduled' && campaign.scheduledAt) {
var scheduled = new Date(campaign.scheduledAt);

if (isFinite(scheduled.getTime()) && scheduled > now) return;
}

try {
results.push(processCampaignBatch_(campaign));
} catch (err) {
saveRecord_('Campaigns', {
id: campaign.id,
status: 'failed',
lastError: safeError_(err)
});

saveRecord_('BroadcastLogs', {
campaignId: campaign.id,
campaignName: campaign.name,
timestamp: nowIso_(),
recipientCount: 0,
status: 'failed',
details: {},
error: safeError_(err)
});

logError_('runScheduledCampaigns_', err);
}
});

return {
ok: true,
processed: results
};
}

function processCampaignBatch_(campaign) {
var recipients = getCampaignRecipients_(campaign);
var total = recipients.length;
var offset = Math.max(0, Number(campaign.sentCount || 0));

if (offset >= total) {
return saveRecord_('Campaigns', {
id: campaign.id,
status: 'sent',
sentCount: total,
totalRecipients: total,
lastError: ''
});
}

var configured = Number(
getSetting_('campaign_batch_size', '300')
);

var batchSize = Math.max(1, Math.min(configured, APP.MAX_MULTICAST_USERS));
var batch = recipients.slice(offset, offset + batchSize);
var ids = batch.map(function(item) {
return String(item.userId || '');
}).filter(function(id) {
return /^U[a-f0-9]{32}``$/i.test(id);
});

if (!ids.length) {
return saveRecord_('Campaigns', {
id: campaign.id,
status: 'sent',
sentCount: total,
totalRecipients: total,
lastError: ''
});
}

var message = buildCampaignMessage_(campaign);

var response = lineApi_(
'/v2/bot/message/multicast',
'post',
{
to: ids,
messages: [message]
},
campaign.channelId || ''
);

var sentCount = offset + batch.length;
var completed = sentCount >= total;

saveRecord_('BroadcastLogs', {
campaignId: campaign.id,
campaignName: campaign.name,
timestamp: nowIso_(),
recipientCount: ids.length,
status: completed ? 'sent' : 'partial',
details: {
offset: offset,
totalRecipients: total,
response: response
},
error: ''
});

var updated = saveRecord_('Campaigns', {
id: campaign.id,
status: completed ? 'sent' : 'queued',
sentCount: sentCount,
totalRecipients: total,
lastError: ''
});

recordUsage_('campaign_recipients_attempted', ids.length, {
campaignId: campaign.id
});

return {
id: campaign.id,
status: updated.status,
sentCount: sentCount,
totalRecipients: total,
batchCount: ids.length
};
}

/* ==========================================================================
W. RICH MENU MANAGEMENT
• ========================================================================== */

function createRichMenu_(payload) {
var p = payload || {};

var richMenuObject = parseJsonObject_(
p.richMenuObject || p.menuJson,
'Rich menu object'
);

var response = lineApi_(
'/v2/bot/richmenu',
'post',
richMenuObject,
p.channelId
);

var saved = saveRecord_('RichMenus', {
name: String(p.name || richMenuObject.name || 'Rich Menu'),
richMenuId: response.richMenuId || '',
altText: String(p.altText || 'Menu'),
selected: toBoolean_(p.selected),
chatBarText: String(p.chatBarText || ''),
menuJson: richMenuObject,
imageUploaded: false,
enabled: true
});

return {
ok: true,
richMenu: saved,
lineResult: response
};
}

function uploadRichMenuImage_(payload) {
var p = payload || {};

if (!p.richMenuId || !p.imageBase64) {
throw new Error('richMenuId and imageBase64 are required');
}

var contentType = String(p.contentType || 'image/png');

if (['image/png', 'image/jpeg'].indexOf(contentType) < 0) {
throw new Error('Image must be PNG or JPEG');
}

var base64 = String(p.imageBase64)
.replace(/^data:image\/[^;]+;base64,/, '');

var bytes = Utilities.base64Decode(base64);

if (bytes.length > 1024 * 1024) {
throw new Error('Rich menu image is too large; maximum is 1 MB');
}

var result = lineUploadRichMenuImage_(
p.richMenuId,
bytes,
contentType,
p.channelId
);

var stored = findRecordByField_(
'RichMenus',
'richMenuId',
String(p.richMenuId)
);

if (stored) {
saveRecord_('RichMenus', {
id: stored.record.id,
imageUploaded: true
});
}

return result;
}

function linkRichMenu_(payload) {
var p = payload || {};

if (!p.userId || !p.richMenuId) {
throw new Error('userId and richMenuId are required');
}

return lineApi_(
'/v2/bot/user/' + encodeURIComponent(p.userId) +
'/richmenu/' + encodeURIComponent(p.richMenuId),
'post',
{},
p.channelId
);
}

function unlinkRichMenu_(payload) {
var p = payload || {};

if (!p.userId) throw new Error('userId is required');

return lineApi_(
'/v2/bot/user/' + encodeURIComponent(p.userId) + '/richmenu',
'delete',
null,
p.channelId
);
}

function setDefaultRichMenu_(payload) {
var p = payload || {};

if (!p.richMenuId) throw new Error('richMenuId is required');

return lineApi_(
'/v2/bot/user/all/richmenu/' + encodeURIComponent(p.richMenuId),
'post',
{},
p.channelId
);
}

function clearDefaultRichMenu_(payload) {
var p = payload || {};

return lineApi_(
'/v2/bot/user/all/richmenu',
'delete',
null,
p.channelId
);
}

function deleteRichMenu_(payload) {
var p = payload || {};

if (!p.richMenuId) throw new Error('richMenuId is required');

return lineApi_(
'/v2/bot/richmenu/' + encodeURIComponent(p.richMenuId),
'delete',
null,
p.channelId
);
}

/* ==========================================================================
X. TRIGGERS AND SCHEDULED JOBS
• ========================================================================== */

function refreshHandoverLoadingIndicators() {
return refreshHandoverLoadingIndicators_();
}

function refreshHandoverLoadingIndicators_() {
var handovers = listRecords_('HandoverQueue', { limit: 1000 });
var active = handovers.filter(function(item) {
return String(item.status || '').toLowerCase() !== 'closed' &&
String(item.userId || '').trim();
});
var refreshed = 0;
var errors = [];

active.forEach(function(item) {
try {
startLoading_({
chatId: item.userId,
loadingSeconds: 60
});
refreshed++;
} catch (err) {
errors.push({
userId: item.userId,
error: safeError_(err)
});
logSystem_('WARN', 'refreshHandoverLoadingIndicators_',
'Could not refresh loading indicator', {
userId: item.userId,
error: safeError_(err)
});
}
});

return {
ok: errors.length === 0,
activeHandovers: active.length,
refreshed: refreshed,
errors: errors
};
}

function installTriggers_() {
var wanted = [
'runScheduledCampaigns',
'scheduledMaintenance',
'refreshHandoverLoadingIndicators'
 ];

var existing = ScriptApp.getProjectTriggers();

wanted.forEach(function(handler) {
var installed = existing.some(function(trigger) {
return trigger.getHandlerFunction() === handler;
});

if (installed) return;

if (handler === 'runScheduledCampaigns') {
ScriptApp.newTrigger(handler)
.timeBased()
.everyMinutes(5)
.create();
} else if (handler === 'refreshHandoverLoadingIndicators') {
ScriptApp.newTrigger(handler)
.timeBased()
.everyMinutes(1)
.create();
} else {
ScriptApp.newTrigger(handler)
.timeBased()
.everyDays(1)
.atHour(3)
.create();
}
});

logAdmin_(
'install_triggers',
'ScheduledJobs',
'',
{ handlers: wanted },
'success'
);

return {
ok: true,
handlers: wanted
};
}

function removeTriggers_() {
var handlers = [
'runScheduledCampaigns',
'scheduledMaintenance',
'refreshHandoverLoadingIndicators'
 ];

var removed = 0;

ScriptApp.getProjectTriggers().forEach(function(trigger) {
if (handlers.indexOf(trigger.getHandlerFunction()) >= 0) {
ScriptApp.deleteTrigger(trigger);
removed++;
}
});

return {
ok: true,
removed: removed
};
}

function runScheduledCampaigns() {
return runScheduledCampaigns_();
}

function scheduledMaintenance() {
return runMaintenance_();
}

function runMaintenance_() {
ensureAllSheets_();

var result = {
time: nowIso_(),
spreadsheetId: getSpreadsheetId_(),
tableCount: Object.keys(TABLE_SCHEMAS).length,
triggers: ScriptApp.getProjectTriggers().map(function(trigger) {
return trigger.getHandlerFunction();
})
};

saveRecord_('ScheduledJobs', {
name: 'Daily maintenance',
jobType: 'maintenance',
status: 'completed',
runAt: nowIso_(),
payload: result,
attempts: 1,
lastError: ''
});

logSystem_('INFO', 'runMaintenance_', 'Maintenance completed', result);

return {
ok: true,
result: result
};
}

function processScheduledJobs_() {
var jobs = listRecords_('ScheduledJobs', { limit: 1000 });
var now = new Date();
var results = [];

jobs.forEach(function(job) {
if (String(job.status || '').toLowerCase() !== 'queued') return;

var runAt = job.runAt ? new Date(job.runAt) : now;

if (isFinite(runAt.getTime()) && runAt > now) return;

try {
saveRecord_('ScheduledJobs', {
id: job.id,
status: 'running',
attempts: Number(job.attempts || 0) + 1
});

if (job.jobType === 'campaigns') {
runScheduledCampaigns_();
} else if (job.jobType === 'maintenance') {
runMaintenance_();
}

saveRecord_('ScheduledJobs', {
id: job.id,
status: 'completed',
lastError: ''
});

results.push({
id: job.id,
status: 'completed'
});

} catch (err) {
saveRecord_('ScheduledJobs', {
id: job.id,
status: 'failed',
lastError: safeError_(err)
});

results.push({
id: job.id,
status: 'failed',
error: safeError_(err)
});
}
});

return {
ok: true,
results: results
};
}

/* ==========================================================================
Y. CSV EXPORT
• ========================================================================== */

function exportTableCsv_(payload) {
var p = payload || {};
var table = validateTable_(p.table);
var sheet = getSheet_(table);
var values = sheet.getDataRange().getDisplayValues();

var csv = values.map(function(row) {
return row.map(function(value) {
var cell = String(value === null || value === undefined ? '' : value);

if (/^[=+-@]/.test(cell)) {
cell = "'" + cell;
}

return '"' + cell.replace(/"/g, '""') + '"';
}).join(',');
}).join('\r\n');

return {
ok: true,
filename: table + '-' +
Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd-HHmmss') +
'.csv',
contentType: 'text/csv;charset=utf-8',
csv: '\uFEFF' + csv
};
}

/* ==========================================================================
Z. USAGE STATS
• ========================================================================== */

function recordUsage_(metric, value, metadata) {
var date = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd');

var existing = listRecords_('UsageStats', { limit: 2000 }).find(function(row) {
return String(row.date || '') === date &&
String(row.metric || '') === String(metric || '');
});

if (existing) {
return saveRecord_('UsageStats', {
id: existing.id,
date: date,
metric: String(metric),
value: Number(existing.value || 0) + Number(value || 0),
metadata: metadata || {}
});
}

return saveRecord_('UsageStats', {
date: date,
metric: String(metric),
value: Number(value || 0),
metadata: metadata || {}
});
}

/* ==========================================================================
AA. COMMON UTILITIES AND LOGGING
• ========================================================================== */

function getSetting_(key, defaultValue) {
var result = findRecordByField_('Settings', 'key', key);

if (result && result.record.value !== undefined) {
return result.record.value;
}

return defaultValue;
}

function getSettingBoolean_(key, defaultValue) {
var value = getSetting_(key, defaultValue);

if (value === undefined || value === null || value === '') {
return Boolean(defaultValue);
}

return toBoolean_(value);
}

function toBoolean_(value) {
if (value === true) return true;
if (value === false) return false;

var text = String(value === undefined || value === null ? '' : value)
.toLowerCase()
.trim();

return ['true', '1', 'yes', 'on', 'enabled'].indexOf(text) >= 0;
}

function parseTags_(value) {
if (Array.isArray(value)) {
return value.map(function(item) {
return String(item).trim();
}).filter(Boolean);
}

return String(value || '').split(',')
.map(function(item) {
return item.trim();
})
.filter(Boolean);
}

function parseJsonObject_(value, label) {
var result = value;

if (typeof value === 'string') {
try {
result = JSON.parse(value);
} catch (err) {
throw new Error((label || 'Value') + ' must be valid JSON');
}
}

if (!result || typeof result !== 'object' || Array.isArray(result)) {
throw new Error((label || 'Value') + ' must be a JSON object');
}

return result;
}

function parseJsonArray_(value) {
if (Array.isArray(value)) return value;

if (typeof value === 'string' && value.trim()) {
try {
var parsed = JSON.parse(value);
return Array.isArray(parsed) ? parsed : [];
} catch (err) {
return [];
}
}

return [];
}

function normalizeWords_(text) {
return String(text || '')
.toLowerCase()
.replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
.split(/\s+/)
.filter(function(word) {
return word.length >= 2;
});
}

function nowIso_() {
return Utilities.formatDate(
new Date(),
APP.TIMEZONE,
"yyyy-MM-dd'T'HH:mm:ss"
);
}

function jsonOutput_(data) {
return ContentService
.createTextOutput(JSON.stringify(data))
.setMimeType(ContentService.MimeType.JSON);
}

function safeError_(err) {
return String(
err && err.message ? err.message : err
).substring(0, 1500);
}

function logError_(source, err) {
logSystem_('ERROR', source, safeError_(err), {
stack: err && err.stack
? String(err.stack).substring(0, 3000)
: ''
});
}

/**
• Log writers append directly. They do not call saveRecord_(), which prevents
• recursive log writes and stack overflow.
*/
function logAdmin_(action, tableName, recordId, details, result) {
try {
appendRecordsDirect_('AdminLogs', [{
id: Utilities.getUuid(),
timestamp: nowIso_(),
action: String(action || ''),
tableName: String(tableName || ''),
recordId: String(recordId || ''),
details: details || {},
result: String(result || '')
}]);
} catch (err) {
Logger.log('[ADMIN LOG FAILURE] ' + safeError_(err));
}
}

function logSystem_(level, source, message, details) {
try {
appendRecordsDirect_('SystemLogs', [{
id: Utilities.getUuid(),
timestamp: nowIso_(),
level: String(level || 'INFO'),
source: String(source || ''),
message: String(message || '').substring(0, 2000),
details: details || {}
}]);
} catch (err) {
Logger.log('[SYSTEM LOG FAILURE] ' + safeError_(err));
}
}