param([ValidateSet('probe','listen','wake','speak')][string]$Mode, [string]$Language = 'en-US')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Send-Result($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 4)) }
try {
  Add-Type -AssemblyName System.Speech
  if ($Mode -eq 'probe') {
    $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name })
    Send-Result @{ type='capabilities'; recognizers=$recognizers; microphone='system-default'; tts=$true }
    exit 0
  }
  if ($Mode -eq 'speak') {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
    $speaker.Speak([string]$payload.text)
    $speaker.Dispose()
    Send-Result @{ type='finished' }
    exit 0
  }
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new([System.Globalization.CultureInfo]::GetCultureInfo($Language))
  if ($Mode -eq 'wake') {
    $builder = [System.Speech.Recognition.GrammarBuilder]::new()
    $builder.Culture = [System.Globalization.CultureInfo]::GetCultureInfo($Language)
    $builder.Append('hey zvyra')
    $recognizer.LoadGrammar([System.Speech.Recognition.Grammar]::new($builder))
  } else { $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new()) }
  $recognizer.SetInputToDefaultAudioDevice()
  $eventId = 'zvyra-speech-' + [Guid]::NewGuid().ToString()
  $subscription = Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -SourceIdentifier $eventId
  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  $command = [Console]::In.ReadLineAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $finishing = $false
  Send-Result @{ type='ready' }
  while ($true) {
    $speechEvent = Get-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue | Select-Object -First 1
    $result = if ($speechEvent) { $speechEvent.SourceEventArgs.Result } else { $null }
    if ($speechEvent) { Remove-Event -EventIdentifier $speechEvent.EventIdentifier }
    if ($result -and $result.Confidence -ge 0.55) {
      Send-Result @{ type='transcript'; text=$result.Text; confidence=$result.Confidence }
      break
    }
    if ($Mode -eq 'listen' -and $command.IsCompleted -and !$finishing) {
      $recognizer.RecognizeAsyncStop()
      $finishing = $true
      $deadline = [DateTime]::UtcNow.AddSeconds(3)
    }
    if ($Mode -eq 'listen' -and [DateTime]::UtcNow -gt $deadline) { Send-Result @{ type='timeout' }; break }
    Start-Sleep -Milliseconds 50
  }
  Unregister-Event -SourceIdentifier $eventId
  $recognizer.RecognizeAsyncCancel()
  $recognizer.Dispose()
} catch {
  Send-Result @{ type='error'; message=$_.Exception.Message }
  exit 1
}
