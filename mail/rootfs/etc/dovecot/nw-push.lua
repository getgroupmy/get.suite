-- New mail, told to the Workspace app as it's delivered (so phones with Workspace notifications on
-- hear about it, even with Workspace closed). Dovecot's push_notification plugin calls these on
-- delivery (LMTP only, so messages saved by mail apps, like sent copies, don't count). The address and
-- key come from the app's settings (policy.conf). Only the sender, subject and folder are sent.
local function esc(s)
  s = tostring(s or "")
  s = s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
    return string.format("\\u%04x", c:byte())
  end)
  return '"' .. s .. '"'
end

function dovecot_lua_notify_begin_txn(user)
  return { user = user.username, url = user:plugin_getenv("nw_push_url"), key = user:plugin_getenv("nw_push_key"), messages = {} }
end

function dovecot_lua_notify_event_message_new(ctx, event)
  table.insert(ctx.messages, { mailbox = event.mailbox, uid = event.uid, from = event.from, subject = event.subject })
end

function dovecot_lua_notify_end_txn(ctx)
  if #ctx.messages == 0 or ctx.url == nil or ctx.url == "" then return end
  local items = {}
  for _, m in ipairs(ctx.messages) do
    table.insert(items, "{" .. '"folder":' .. esc(m.mailbox) .. ',"uid":' .. tostring(tonumber(m.uid) or 0) .. ',"from":' .. esc(m.from) .. ',"subject":' .. esc(m.subject) .. "}")
  end
  local body = '{"user":' .. esc(ctx.user) .. ',"messages":[' .. table.concat(items, ",") .. "]}"
  local client = dovecot.http.client({ timeout = 3000, max_attempts = 1, debug = false })
  local req = client:request({ url = ctx.url, method = "POST" })
  req:add_header("content-type", "application/json")
  req:add_header("x-policy-key", ctx.key or "")
  req:set_payload(body)
  req:submit()
end
