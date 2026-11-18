--[[
LaunchPad Studio: a read-only scan of the open place, for LaunchPad's five optimizers.
- Never changes the game: it only reads instances, properties, attributes and (if you allow it) script code.
- Unpaired, it sends nothing to LaunchPad; it only looks up the place's public listing on Roblox. You can copy a summary by hand.
- Paired with a LaunchPad account (Light or Max), "Sync this game" sends the summary to that account over HTTPS.
- Script code never leaves Studio: only feature flags, script paths and numbers from configuration tables go into the summary.
- It never downloads or runs code from LaunchPad. Scanned code is treated as text and never executed.
Install: download this file from LaunchPad's Studio page, put it in Studio's Plugins folder (Plugins tab > Plugins Folder) and restart Studio.
]]
local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")

local VERSION = "0.1.0"
local MAX = { texts = 80, prompts = 40, economy = 60, paths = 5 }
local SERVICES = { "Workspace", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer" }

-- Feature words, matched at word starts after camelCase is split ("ClaimDailyReward" -> "claim daily reward").
-- "ui" words are also checked in instance names; script code is only checked for the "code" list when allowed.
local FEATURES = {
	daily = { ui = { "daily" }, code = { "daily" } },
	streak = { ui = { "streak" }, code = { "streak" } },
	offline = { ui = { "offline" }, code = { "offline" } },
	quests = { ui = { "quest" }, code = { "quest" } },
	events = { ui = { "event" }, code = {} }, -- "event" is everywhere in code (RemoteEvent), so UI and names only
	limited = { ui = { "limited" }, code = {} },
	trading = { ui = { "trade", "trading" }, code = { "trade" } },
	parties = { ui = { "party" }, code = { "party" } },
	guilds = { ui = { "guild", "clan" }, code = { "guild", "clan" } },
	leaderboards = { ui = { "leaderboard" }, code = { "leaderstats", "leaderboard", "ordered data store" } },
	invites = { ui = { "invite" }, code = { "invite" } },
	pvp = { ui = { "pvp", "duel" }, code = { "pvp", "duel" } },
	tutorial = { ui = { "tutorial" }, code = { "tutorial", "onboard" } },
	rebirth = { ui = { "rebirth", "prestige" }, code = { "rebirth", "prestige" } },
	saves = { ui = {}, code = { "data store", "profile service", "profile store" } },
	gamepass = { ui = { "gamepass", "game pass" }, code = { "game pass", "prompt product purchase", "process receipt" } },
}

local function words(s)
	-- "DataStoreService" -> " data store service "
	return " " .. s:gsub("(%l)(%u)", "%1 %2"):gsub("[%p_]", " "):lower() .. " "
end
local function hasWord(text, w)
	return text:find(" " .. w, 1, true) ~= nil
end
local function short(path)
	return path:gsub("^game%.", "")
end

local function newFeatures()
	local f = {}
	for k in pairs(FEATURES) do
		f[k] = {}
	end
	return f
end
local function note(found, key, where)
	local list = found[key]
	if #list < MAX.paths and not table.find(list, where) then
		table.insert(list, where)
	end
end
local function checkText(found, text, where, kind, isName)
	local t = words(text)
	for key, f in pairs(FEATURES) do
		if isName and (key == "events" or key == "limited") then continue end -- names like "ClaimEvent" are remotes, not timed events
		for _, w in ipairs(f[kind]) do
			if hasWord(t, w) then
				note(found, key, where)
				break
			end
		end
	end
end

-- Economy fields: a key counts as a cost if it says price/cost, as income if it says income/per second/earn.
local function classify(key)
	local k = key:lower()
	if k:find("price") or k:find("cost") then
		return "cost"
	elseif k:find("income") or k:find("persec") or k:find("earn") or k == "cps" then
		return "income"
	elseif k:find("reward") or k:find("multiplier") or k:find("boost") then
		return "reward"
	end
	return nil
end
local function entryFrom(fields, name, where, source)
	if not fields.cost then
		return nil
	end
	return {
		name = name, cost = fields.cost, income = fields.income, incomeKey = fields.incomeKey,
		reward = fields.reward, rewardKey = fields.rewardKey, path = where, source = source,
	}
end
local function addField(fields, key, value)
	local kind = classify(key)
	if kind and type(value) == "number" and fields[kind] == nil then
		fields[kind] = value
		fields[kind .. "Key"] = key
	end
end

-- Economy table entries in ModuleScript code, e.g. Eggs = { Common = { Price = 100, Income = 5 } }.
-- shortcut: pattern-based, misses values computed at runtime (those need the code to run); upgrade to a Luau parser if that matters.
local function scanTables(src, where, out)
	local i = 1
	while #out < MAX.economy do
		local s, e = src:find("%b{}", i)
		if not s then
			break
		end
		local body = src:sub(s + 1, e - 1)
		local flat = "," .. body:gsub("%b{}", "")
		local fields = {}
		for key, n in flat:gmatch("[,;%s]%[?[\"']?([%a_][%w_ ]*)[\"']?%]?%s*=%s*[\"']?(%-?%d[%d_]*%.?%d*)") do -- quoted digits too: big-number configs store prices as strings
			addField(fields, key, tonumber((n:gsub("_", ""))))
		end
		local name = flat:match("[Dd]isplay[Nn]ame%s*=%s*[\"']([^\"']+)") or flat:match("[,;%s][Nn]ame%s*=%s*[\"']([^\"']+)")
		if not name then
			local before = src:sub(math.max(1, s - 80), s - 1)
			name = before:match("%[%s*[\"']([^\"']+)[\"']%s*%]%s*=%s*$") or before:match("([%a_][%w_]*)%s*=%s*$")
		end
		local entry = entryFrom(fields, name or "Unnamed", where, "Analyzed from script logic")
		if entry then
			table.insert(out, entry)
		end
		scanTables(body, where, out)
		i = e + 1
	end
end

-- Values stored in the DataModel: number attributes or NumberValue/IntValue children on one object.
local function fieldsOf(inst)
	local fields = {}
	for key, value in pairs(inst:GetAttributes()) do
		addField(fields, key, value)
	end
	for _, child in ipairs(inst:GetChildren()) do
		if child:IsA("NumberValue") or child:IsA("IntValue") then
			addField(fields, child.Name, child.Value)
		end
	end
	return fields
end

local function scan(readCode)
	local found, texts, seenText, prompts, economy = newFeatures(), {}, {}, {}, {}
	local counts = { instances = 0, scripts = 0, localScripts = 0, modules = 0, screenGuis = 0, spawns = 0, prompts = 0, codeRead = 0 }
	local hasSkip = false

	for _, name in ipairs(SERVICES) do
		local ok, service = pcall(game.GetService, game, name)
		if ok and service then
			for _, inst in ipairs(service:GetDescendants()) do
				counts.instances += 1
				local where = short(inst:GetFullName())
				checkText(found, inst.Name, where, "ui", true)
				if inst:IsA("ModuleScript") or inst:IsA("LocalScript") or inst:IsA("Script") then
					local key = inst:IsA("ModuleScript") and "modules" or inst:IsA("LocalScript") and "localScripts" or "scripts"
					counts[key] += 1
					if readCode then
						local okSrc, src = pcall(function() return game:GetService("ScriptEditorService"):GetEditorSource(inst) end)
						 if not okSrc or not src then okSrc, src = pcall(function() return inst.Source end) end
						if okSrc and src then
							counts.codeRead += 1
							checkText(found, src, where, "code")
							if inst:IsA("ModuleScript") and #economy < MAX.economy then
								scanTables(src, where, economy)
							end
						end
					end
				elseif inst:IsA("SpawnLocation") then
					counts.spawns += 1
				elseif inst:IsA("ProximityPrompt") then
					counts.prompts += 1
					local id = inst.ActionText .. "|" .. inst.ObjectText -- the same prompt on every player plot counts once
					if #prompts < MAX.prompts and not seenText[id] then
						seenText[id] = true
						table.insert(prompts, { action = inst.ActionText, object = inst.ObjectText, path = where })
					end
					checkText(found, inst.ActionText .. " " .. inst.ObjectText, where, "ui")
				elseif inst:IsA("ScreenGui") and name == "StarterGui" then
					counts.screenGuis += 1
				elseif (inst:IsA("TextLabel") or inst:IsA("TextButton")) and name == "StarterGui" then
					local t = inst.Text:gsub("<[^>]+>", ""):gsub("%s+", " "):match("^%s*(.-)%s*$")
					if #t > 1 and #t <= 120 and not seenText[t] then
						seenText[t] = true
						if #texts < MAX.texts then
							table.insert(texts, t)
						end
						if t:lower():find("skip") then
							hasSkip = true
						end
						checkText(found, t, where, "ui")
					end
				end
				if #economy < MAX.economy and not inst:IsA("LuaSourceContainer") then
					local entry = entryFrom(fieldsOf(inst), inst.Name, where, "Read from Studio DataModel")
					if entry then
						table.insert(economy, entry)
					end
				end
			end
		end
	end

	local place = {
		placeId = game.PlaceId, universeId = game.GameId, name = game.Name,
		creatorId = game.CreatorId, creatorType = game.CreatorType.Name, published = game.PlaceId > 0,
	}
	if place.published then
		local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, game.PlaceId)
		if ok and info then
			place.name = info.Name or place.name
			place.description = info.Description
			place.iconAssetId = info.IconImageAssetId
			place.creatorName = info.Creator and info.Creator.Name
			place.listingSource = "Retrieved from Roblox"
		end
	end

	return {
		launchpadScan = 1, plugin = VERSION, scannedAt = os.time(), codeRead = readCode,
		place = place, counts = counts, ui = { texts = texts, hasSkip = hasSkip }, prompts = prompts,
		features = found, economy = economy,
	}
end

-- Test hook: run outside a plugin (e.g. the command bar) to get the summary without the panel.
if not plugin then
	return HttpService:JSONEncode(scan(true))
end

---------------------------------------------------------------- LaunchPad connection
-- The server fills in its own address when you download the plugin. No secrets live in this file.
local LAUNCHPAD_URL = "__LAUNCHPAD_URL__"
local TOKEN_KEY = "launchpad_token" -- per-installation token from pairing; revocable from LaunchPad

local function request(method, path, body)
	local token = plugin:GetSetting(TOKEN_KEY)
	local headers = { ["Content-Type"] = "application/json" }
	if token then headers.Authorization = "Bearer " .. token end
	local ok, res = pcall(HttpService.RequestAsync, HttpService, { Url = LAUNCHPAD_URL .. path, Method = method, Headers = headers, Body = body and HttpService:JSONEncode(body) or nil })
	if not ok then
		local msg = tostring(res)
		if msg:find("permission") or msg:find("Http requests") then return nil, "Studio blocked the request. Allow LaunchPad Studio to reach " .. LAUNCHPAD_URL .. " (Plugins > Manage Plugins > LaunchPad Studio > HTTP)." end
		return nil, "Couldn't reach LaunchPad. Check your connection and try again."
	end
	local data = {}
	pcall(function() data = HttpService:JSONDecode(res.Body) end)
	if res.StatusCode == 401 then plugin:SetSetting(TOKEN_KEY, nil) end
	if not res.Success then return nil, data.error or ("LaunchPad returned " .. res.StatusCode), res.StatusCode end
	return data
end

---------------------------------------------------------------- panel
local toolbar = plugin:CreateToolbar("LaunchPad")
local button = toolbar:CreateButton("LaunchPad Studio", "Sync this game with LaunchPad (read-only)", "")
button.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui("LaunchPadStudio",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 340, 560, 280, 380))
widget.Title = "LaunchPad Studio"
button.Click:Connect(function() widget.Enabled = not widget.Enabled end)
widget:GetPropertyChangedSignal("Enabled"):Connect(function() button:SetActive(widget.Enabled) end)

local theme = settings().Studio.Theme
local C = Enum.StudioStyleGuideColor
local function color(c) return theme:GetColor(c) end

local root = Instance.new("ScrollingFrame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = color(C.MainBackground)
root.BorderSizePixel = 0
root.AutomaticCanvasSize = Enum.AutomaticSize.Y
root.CanvasSize = UDim2.new()
root.ScrollBarThickness = 6
root.Parent = widget
local pad = Instance.new("UIPadding")
for _, side in ipairs({ "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight" }) do pad[side] = UDim.new(0, 12) end
pad.Parent = root
local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 8)
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = root

local order = 0
local function add(class, props)
	order += 1
	local o = Instance.new(class)
	o.LayoutOrder = order
	o.Size = UDim2.new(1, -6, 0, 0)
	o.AutomaticSize = Enum.AutomaticSize.Y
	o.BorderSizePixel = 0
	o.BackgroundTransparency = 1
	o.Font = Enum.Font.Gotham
	o.TextSize = 14
	o.TextWrapped = true
	o.TextXAlignment = Enum.TextXAlignment.Left
	o.TextColor3 = color(C.MainText)
	for k, v in pairs(props) do o[k] = v end
	o.Parent = root
	return o
end
local function dim(text, size) return add("TextLabel", { Text = text, TextSize = size or 12, TextColor3 = color(C.DimmedText) }) end
local function btn(text, primary)
	local b = add("TextButton", { Text = text, Size = UDim2.new(1, -6, 0, 40), AutomaticSize = Enum.AutomaticSize.None,
		BackgroundTransparency = 0, Font = Enum.Font.GothamBold, TextXAlignment = Enum.TextXAlignment.Center,
		BackgroundColor3 = primary and Color3.fromRGB(41, 42, 39) or color(C.Button),
		TextColor3 = primary and Color3.fromRGB(247, 246, 241) or color(C.ButtonText) })
	Instance.new("UICorner", b).CornerRadius = UDim.new(0, 20)
	return b
end

-- Logo: the LaunchPad tile, drawn with UI (no external image asset).
order += 1
local logoRow = Instance.new("Frame"); logoRow.LayoutOrder = order; logoRow.Size = UDim2.new(1, -6, 0, 32); logoRow.BackgroundTransparency = 1; logoRow.Parent = root
local tile = Instance.new("Frame"); tile.Size = UDim2.fromOffset(26, 26); tile.Position = UDim2.fromOffset(0, 3); tile.Rotation = -14
tile.BackgroundColor3 = color(C.MainText); tile.BorderSizePixel = 0; tile.Parent = logoRow; Instance.new("UICorner", tile).CornerRadius = UDim.new(0, 6)
local title = Instance.new("TextLabel"); title.Text = "LaunchPad Studio"; title.Font = Enum.Font.GothamBold; title.TextSize = 18; title.TextColor3 = color(C.MainText)
title.BackgroundTransparency = 1; title.Position = UDim2.fromOffset(36, 0); title.Size = UDim2.new(1, -36, 1, 0); title.TextXAlignment = Enum.TextXAlignment.Left; title.Parent = logoRow

local status = add("TextLabel", { Text = "", Font = Enum.Font.GothamBold })
local account = dim("")
local experience = dim("", 13)
local permission = dim("")
local syncBtn = btn("Sync this game with LaunchPad", true)
local progress = add("TextLabel", { Text = "" })
local lastSync = dim("")
local connectBtn = btn("Connect to LaunchPad", false)
local codeLabel = add("TextLabel", { Text = "", Font = Enum.Font.Code, TextSize = 22, TextXAlignment = Enum.TextXAlignment.Center, Visible = false })
local autoBtn = btn("", false)
dim("Read-only: LaunchPad Studio never edits scripts, deletes objects, changes settings, publishes or uploads assets.")

-- Manual path (free): scan and copy the summary into LaunchPad's Studio page.
local manualTitle = add("TextLabel", { Text = "Manual summary (no account needed)", Font = Enum.Font.GothamBold })
local readCodeManual = false
local codeToggle = btn("", false)
local function drawToggle() codeToggle.Text = (readCodeManual and "[x] " or "[  ] ") .. "Also read script code" end
drawToggle()
codeToggle.MouseButton1Click:Connect(function() readCodeManual = not readCodeManual drawToggle() end)
local scanBtn = btn("Scan and show summary", false)
local out = add("TextBox", { Text = "", PlaceholderText = "The summary appears here.", ClearTextOnFocus = false, TextEditable = true,
	MultiLine = true, TextSize = 11, Font = Enum.Font.Code, Size = UDim2.new(1, -6, 0, 120), AutomaticSize = Enum.AutomaticSize.None,
	BackgroundTransparency = 0, BackgroundColor3 = color(C.InputFieldBackground), TextYAlignment = Enum.TextYAlignment.Top, Visible = false })
dim("Click the box, press Ctrl+A then Ctrl+C, and paste it into LaunchPad > Studio > Paste your scan. Your code stays in Studio: only feature names, script paths and numbers go into the summary.")
out.Focused:Connect(function() out.SelectionStart = 1 out.CursorPosition = #out.Text + 1 end)

local state = { status = nil, pairing = false, busy = false }
local function setting(k) return plugin:GetSetting(k) end
local function autoKey() return "launchpad_auto_" .. tostring(game.GameId) end

local function refresh()
	experience.Text = game.GameId > 0 and ("Experience: " .. game.Name .. "\nExperience ID " .. game.GameId .. " · Place ID " .. game.PlaceId)
		or "This place isn't published, so it has no experience ID. You can still make a manual summary."
	local s = state.status
	if s then
		status.Text = "Connected"
		account.Text = "LaunchPad account: " .. tostring(s.account) .. " · plan: " .. tostring(s.plan)
		local authorized = false
		for _, e in ipairs(s.experiences or {}) do if tostring(e.universe_id) == tostring(game.GameId) then authorized = true end end
		permission.Text = (not s.canSync and "Automatic sync needs a Light or Max plan." )
			or (not s.robloxConnected and "Connect Roblox in LaunchPad (Settings > Connected accounts) first.")
			or (not authorized and "Roblox hasn't authorized this experience for your LaunchPad account. Connect Roblox again and allow it.")
			or ("Ready to sync. Script reading: " .. (s.scriptInspectionAllowed and "allowed" or "off (change in LaunchPad > Settings > Privacy)") .. ".")
		syncBtn.Visible = s.canSync and authorized and true or false
		connectBtn.Text = "Disconnect from LaunchPad"
		autoBtn.Visible = syncBtn.Visible
		autoBtn.Text = (setting(autoKey()) and "[x] " or "[  ] ") .. "Sync automatically when I open this place"
	else
		status.Text = state.pairing and "Pairing…" or "Not connected"
		account.Text = state.pairing and "Enter this code on LaunchPad's Studio page while signed in:" or "Connect to sync with your LaunchPad account (Light or Max). Or make a manual summary below."
		permission.Text = ""; syncBtn.Visible = false; autoBtn.Visible = false
		connectBtn.Text = state.pairing and "Cancel pairing" or "Connect to LaunchPad"
	end
	codeLabel.Visible = state.pairing
	local t = setting("launchpad_last_" .. tostring(game.GameId))
	lastSync.Text = t and ("Last successful sync: " .. os.date("%Y-%m-%d %H:%M", t)) or ""
end

local function loadStatus()
	if not setting(TOKEN_KEY) then state.status = nil refresh() return end
	local s, err = request("GET", "/api/plugin/status")
	state.status = s
	if not s then progress.Text = err end
	refresh()
end

local function sync(auto)
	if state.busy or not state.status then return end
	state.busy = true
	syncBtn.Text = "Syncing…"
	progress.Text = "Scanning the place (read-only)…"
	local ok, data = pcall(scan, state.status.scriptInspectionAllowed == true)
	if not ok then
		progress.Text = "The scan stopped: " .. tostring(data) .. ". Nothing in your game was changed."
	else
		progress.Text = "Sending the summary to LaunchPad…"
		local res, err = request("POST", "/api/plugin/scans", { scan = data })
		if not res then
			progress.Text = err
		else
			local done = false
			for _ = 1, 40 do
				task.wait(1.5)
				local j = request("GET", "/api/plugin/scans/" .. res.jobId)
				if j and j.status == "done" then done = true break end
				if j and j.status == "failed" then progress.Text = "LaunchPad couldn't process this scan: " .. tostring(j.error) break end
				progress.Text = "LaunchPad is processing the scan…"
			end
			if done then
				plugin:SetSetting("launchpad_last_" .. tostring(game.GameId), os.time())
				progress.Text = (auto and "Synced automatically. " or "Synced. ") .. "Open LaunchPad > Studio to see the analysis."
			end
		end
	end
	syncBtn.Text = "Sync this game with LaunchPad"
	state.busy = false
	refresh()
end

local function startPairing()
	local p, err = request("POST", "/api/plugin/pair/start")
	if not p then progress.Text = err return end
	state.pairing = true
	codeLabel.Text = p.code:sub(1, 4) .. "-" .. p.code:sub(5)
	progress.Text = "Open " .. LAUNCHPAD_URL .. " > Studio and enter the code. It expires in 10 minutes."
	refresh()
	task.spawn(function()
		local deadline = os.clock() + p.expiresInSeconds
		while state.pairing and os.clock() < deadline do
			task.wait(3)
			local r, e, code = request("POST", "/api/plugin/pair/poll", { pairingId = p.pairingId, pollSecret = p.pollSecret })
			if r and r.token then
				plugin:SetSetting(TOKEN_KEY, r.token)
				state.pairing = false
				progress.Text = "Connected."
				loadStatus()
				return
			elseif not r and code and code ~= 429 then
				progress.Text = e
				break
			end
		end
		if state.pairing then state.pairing = false progress.Text = "Pairing expired. Start again." refresh() end
	end)
end

connectBtn.MouseButton1Click:Connect(function()
	if state.pairing then state.pairing = false progress.Text = "" refresh()
	elseif state.status then
		request("POST", "/api/plugin/disconnect")
		plugin:SetSetting(TOKEN_KEY, nil)
		state.status = nil
		progress.Text = "Disconnected. This plugin no longer has access to your LaunchPad account."
		refresh()
	else startPairing() end
end)
syncBtn.MouseButton1Click:Connect(function() sync(false) end)
autoBtn.MouseButton1Click:Connect(function() plugin:SetSetting(autoKey(), not setting(autoKey())) refresh() end)

scanBtn.MouseButton1Click:Connect(function()
	local ok, data = pcall(scan, readCodeManual)
	if ok then
		out.Text = HttpService:JSONEncode(data)
		out.Visible = true
		progress.Text = ("Scanned %d objects. Copy the summary below."):format(data.counts.instances)
	else
		progress.Text = "The scan stopped: " .. tostring(data) .. ". Nothing in your game was changed."
	end
end)

-- When a paired place opens: sync once if the developer turned on auto-sync and the plan's interval has passed.
task.spawn(function()
	refresh()
	loadStatus()
	local s = state.status
	if s and s.canSync and setting(autoKey()) and game.GameId > 0 then
		local last = setting("launchpad_last_" .. tostring(game.GameId)) or 0
		local interval = (s.syncIntervalMinutes or 0) * 60
		if os.time() - last >= interval then sync(true) end
	end
end)

