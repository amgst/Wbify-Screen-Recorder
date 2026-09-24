param(
  [string]$InitialMessage = "Create a concise Shopify theme implementation plan for a premium storefront, then explain the first three Liquid sections you would build.",
  [string]$ProjectId = $(if ($env:OPENAI_PROJECT_ID) { $env:OPENAI_PROJECT_ID } else { "proj_8p71wI3Cn8agMGX8Q1rPRfL8" }),
  [string]$AgentId = "agent_1f2ddba150e84ab09a8bd51895dfc7572f4432542af54d0080",
  [string]$AgentName = "Shopify Theme",
  [string]$SessionId = "",
  [string]$ToolResultsPath = "",
  [ValidateSet("disabled", "enabled", "restricted")]
  [string]$NetworkAccess = "disabled",
  [switch]$VerboseEvents,
  [switch]$NoAutoToolError
)

$ErrorActionPreference = "Stop"

if (-not $env:OPENAI_API_KEY) {
  throw "OPENAI_API_KEY is not set. In PowerShell, run: `$env:OPENAI_API_KEY = 'sk-...'"
}

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) {
  throw "curl.exe was not found on PATH. Install curl or run this from a shell where curl.exe is available."
}

$apiBase = "https://api.openai.com/v1"
$headers = @(
  "-H", "OpenAI-Beta: agents=v1",
  "-H", "Authorization: Bearer $env:OPENAI_API_KEY",
  "-H", "OpenAI-Project: $ProjectId",
  "-H", "Content-Type: application/json"
)

$toolResults = @{}
if ($ToolResultsPath) {
  if (-not (Test-Path -LiteralPath $ToolResultsPath)) {
    throw "Tool results file not found: $ToolResultsPath"
  }
  $parsedToolResults = Get-Content -LiteralPath $ToolResultsPath -Raw | ConvertFrom-Json
  foreach ($prop in $parsedToolResults.PSObject.Properties) {
    $toolResults[$prop.Name] = $prop.Value
  }
}

function ConvertTo-JsonFile {
  param(
    [Parameter(Mandatory)]$Body,
    [Parameter(Mandatory)][string]$Path
  )

  $Body | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Invoke-AgentJsonPost {
  param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)]$Body
  )

  $path = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-api-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    ConvertTo-JsonFile -Body $Body -Path $path
    $response = & curl.exe -sS --fail-with-body $Url @headers -d "@$path"
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed with exit code $LASTEXITCODE"
    }
    return ($response | ConvertFrom-Json)
  }
  finally {
    Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue
  }
}

function Get-ToolOutput {
  param([Parameter(Mandatory)]$Action)

  if ($toolResults.ContainsKey($Action.call_id)) {
    return @{ success = $true; output = ($toolResults[$Action.call_id] | ConvertTo-Json -Depth 20 -Compress) }
  }

  if ($toolResults.ContainsKey($Action.name)) {
    return @{ success = $true; output = ($toolResults[$Action.name] | ConvertTo-Json -Depth 20 -Compress) }
  }

  if ($NoAutoToolError) {
    return $null
  }

  return @{
    success = $false
    error = "No local handler or configured result was provided for function '$($Action.name)' call '$($Action.call_id)'. Add a result in a JSON file and rerun with -ToolResultsPath."
  }
}

function Submit-ToolResults {
  param(
    [Parameter(Mandatory)][string]$ActiveSessionId,
    [Parameter(Mandatory)]$RequiredActions
  )

  $events = @()
  foreach ($action in @($RequiredActions)) {
    if ($action.type -ne "function_call") {
      Write-Host ""
      Write-Host "[requires_action] Unsupported action type: $($action.type)"
      continue
    }

    Write-Host ""
    Write-Host "[tool_call] $($action.name) call_id=$($action.call_id)"
    if ($VerboseEvents) {
      Write-Host ($action | ConvertTo-Json -Depth 20)
    }

    $outcome = Get-ToolOutput -Action $action
    if ($null -eq $outcome) {
      Write-Host "[tool_call] Waiting for external tool result because -NoAutoToolError was set."
      continue
    }

    $event = @{
      type = "agent.session.input.tool_result"
      turn_id = $action.turn_id
      call_id = $action.call_id
      success = [bool]$outcome.success
    }

    if ($outcome.success) {
      $event.output = [string]$outcome.output
    }
    else {
      $event.error = [string]$outcome.error
    }

    $events += $event
  }

  if ($events.Count -gt 0) {
    [void](Invoke-AgentJsonPost -Url "$apiBase/agents/sessions/$ActiveSessionId/events" -Body @{ events = $events })
    Write-Host "[tool_call] Submitted $($events.Count) tool result event(s)."
  }
}

function Join-ProcessArguments {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $quoted = foreach ($arg in $Arguments) {
    if ($arg -match '[\s"]') {
      $escaped = $arg -replace '(\\*)"', '$1$1\"'
      $escaped = $escaped -replace '(\\+)$', '$1$1'
      '"' + $escaped + '"'
    }
    else {
      $arg
    }
  }

  return ($quoted -join " ")
}

function Handle-AgentEvent {
  param(
    [Parameter(Mandatory)]$Event,
    [ref]$ActiveSessionId,
    [ref]$RootTurnFinished,
    [ref]$SawFailure
  )

  if ($Event.session.id -and -not $ActiveSessionId.Value) {
    $ActiveSessionId.Value = $Event.session.id
    Write-Host ""
    Write-Host "[session] $($ActiveSessionId.Value)"
  }
  elseif ($Event.session_id -and -not $ActiveSessionId.Value) {
    $ActiveSessionId.Value = $Event.session_id
    Write-Host ""
    Write-Host "[session] $($ActiveSessionId.Value)"
  }

  switch ($Event.type) {
    "agent.session.turn.output_text.delta" {
      Write-Host -NoNewline $Event.delta
    }
    "agent.session.turn.output_text.done" {
      Write-Host ""
    }
    "agent.session.requires_action" {
      if ($Event.session.required_actions -and $ActiveSessionId.Value) {
        Submit-ToolResults -ActiveSessionId $ActiveSessionId.Value -RequiredActions $Event.session.required_actions
      }
      else {
        Write-Host ""
        Write-Host "[requires_action] The stream requested input, but no session id or required_actions payload was available."
      }
    }
    "agent.session.turn.completed" {
      if (-not $Event.turn.subagent_id) {
        $RootTurnFinished.Value = $true
        Write-Host ""
        Write-Host "[completed] Root turn completed."
      }
    }
    "agent.session.turn.failed" {
      if (-not $Event.turn.subagent_id) {
        $SawFailure.Value = $true
        Write-Host ""
        Write-Host "[failed] $($Event.turn.error.message)"
      }
    }
    "agent.session.turn.cancelled" {
      if (-not $Event.turn.subagent_id) {
        $SawFailure.Value = $true
        Write-Host ""
        Write-Host "[cancelled] Root turn was cancelled."
      }
    }
    "agent.session.failed" {
      $SawFailure.Value = $true
      Write-Host ""
      Write-Host "[failed] Session failed."
    }
    "agent.session.environment.failed" {
      $SawFailure.Value = $true
      Write-Host ""
      Write-Host "[failed] Environment setup failed."
      if ($Event.environment.error.message) {
        Write-Host $Event.environment.error.message
      }
    }
    "error" {
      $SawFailure.Value = $true
      Write-Host ""
      Write-Host "[error] $($Event.error.message)"
    }
    default {
      if ($VerboseEvents) {
        Write-Host ""
        Write-Host "[event] $($Event.type)"
        Write-Host ($Event | ConvertTo-Json -Depth 20)
      }
    }
  }
}

function Stream-CurlEvents {
  param(
    [Parameter(Mandatory)][string]$Url,
    [string]$PayloadPath = "",
    [ref]$ActiveSessionId
  )

  $rootTurnFinished = $false
  $sawFailure = $false
  $curlArgs = @("-N", "--no-buffer", "--fail-with-body", $Url) + $headers
  if ($PayloadPath) {
    $curlArgs += @("-d", "@$PayloadPath")
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "curl.exe"
  $psi.Arguments = Join-ProcessArguments -Arguments $curlArgs
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::Start($psi)
  try {
    while (-not $process.StandardOutput.EndOfStream) {
      $line = [string]$process.StandardOutput.ReadLine()
      if (-not $line.StartsWith("data:")) {
        continue
      }

      $data = $line.Substring(5).Trim()
      if (-not $data -or $data -eq "[DONE]") {
        continue
      }

      try {
        $event = $data | ConvertFrom-Json
        Handle-AgentEvent -Event $event -ActiveSessionId $ActiveSessionId -RootTurnFinished ([ref]$rootTurnFinished) -SawFailure ([ref]$sawFailure)
      }
      catch {
        Write-Host ""
        Write-Host "[stream] Could not parse event: $data"
        Write-Host $_.Exception.Message
      }

      if ($rootTurnFinished -or $sawFailure) {
        break
      }
    }

    if (-not $process.HasExited) {
      $process.Kill()
    }

    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -and -not ($rootTurnFinished -or $sawFailure)) {
      if ($stderr) {
        Write-Host $stderr
      }
      throw "curl failed with exit code $($process.ExitCode)"
    }
  }
  finally {
    if ($process -and -not $process.HasExited) {
      $process.Kill()
    }
  }

  if ($sawFailure) {
    throw "The session or root turn reported a failure. See stream output above."
  }
  if (-not $rootTurnFinished) {
    Write-Host "[stream] Stream closed before a root turn completion event. Retrieve saved items to recover state."
  }
}

Write-Host "Using project: $ProjectId"
Write-Host "Using agent:   $AgentName ($AgentId)"

$activeSessionId = $SessionId
if ($activeSessionId) {
  Write-Host "Continuing session: $activeSessionId"
  [void](Invoke-AgentJsonPost -Url "$apiBase/agents/sessions/$activeSessionId/events" -Body @{
    events = @(
      @{
        type = "agent.session.input.message"
        input = @(
          @{
            role = "user"
            content = @(@{ type = "input_text"; text = $InitialMessage })
          }
        )
      }
    )
  })
  Stream-CurlEvents -Url "$apiBase/agents/sessions/$activeSessionId/events?stream=true" -ActiveSessionId ([ref]$activeSessionId)
}
else {
  $payload = @{
    agent_id = $AgentId
    agent = @{
      model = "gpt-6-astra"
      instructions = "Develop shopify professional themes."
      reasoning = @{
        effort = "medium"
        summary = "auto"
      }
      text = @{
        format = @{ type = "text" }
        verbosity = "medium"
      }
    }
    environment = @{
      type = "openai_hosted"
      network = @{ access = $NetworkAccess }
      setup_commands = @(
        @{ command = "mkdir -p /workspace/outputs/theme && node --version && python3 --version" }
      )
    }
    input = @(
      @{
        role = "user"
        content = @(@{ type = "input_text"; text = $InitialMessage })
      }
    )
    stream = $true
  }

  $payloadPath = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-api-session-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    ConvertTo-JsonFile -Body $payload -Path $payloadPath
    Stream-CurlEvents -Url "$apiBase/agents/sessions" -PayloadPath $payloadPath -ActiveSessionId ([ref]$activeSessionId)
  }
  finally {
    Remove-Item -LiteralPath $payloadPath -ErrorAction SilentlyContinue
  }
}

if ($activeSessionId) {
  Write-Host ""
  Write-Host "Session id: $activeSessionId"
  Write-Host "List saved items:"
  Write-Host "curl.exe `"https://api.openai.com/v1/agents/sessions/$activeSessionId/items?order=asc&limit=100`" -H `"OpenAI-Beta: agents=v1`" -H `"Authorization: Bearer `$env:OPENAI_API_KEY`" -H `"OpenAI-Project: $ProjectId`""
}
