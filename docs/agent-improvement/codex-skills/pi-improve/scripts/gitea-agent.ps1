param([ValidateSet('user','list','push','pr','info','fork')][string]$Action='user', [string]$Branch, [string]$Base, [string]$Title, [string]$BodyFile, [string]$Owner='agrace1-standard', [string]$HeadOwner)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
  public uint Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target,uint type,uint reserved,out IntPtr credential);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
 public static string[] Read(string target) {
  IntPtr pointer; if(!CredRead(target,1,0,out pointer)) throw new Exception("Dedicated credential unavailable");
  try { var c=Marshal.PtrToStructure<CREDENTIAL>(pointer); return new[]{c.UserName,Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2)}; }
  finally {CredFree(pointer);}
 }
}
'@
$credential = [PiCredential]::Read('git:http://coding-agent-a01@10.0.2.73:3080/agrace1-standard/misc-tooling-offsec-scripts.git')
if ($credential[0] -ne 'coding-agent-a01') { throw 'Unexpected credential identity' }
$api='http://10.0.2.73:3080/api/v1'
$headers=@{Authorization=('Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($credential[0]+':'+$credential[1]))))}
$user=Invoke-RestMethod -Uri "$api/user" -Headers $headers -TimeoutSec 20
if ($user.login -ne 'coding-agent-a01') { throw 'Authenticated identity mismatch' }
$repo="$Owner/misc-agents-pi-kit"
if ($Action -eq 'info') { Invoke-RestMethod -Uri "$api/repos/$repo" -Headers $headers -TimeoutSec 20 | Select-Object full_name,permissions,fork; exit }
if ($Action -eq 'fork') { Invoke-RestMethod -Method Post -Uri "$api/repos/agrace1-standard/misc-agents-pi-kit/forks" -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 30 | Select-Object full_name,html_url; exit }
if ($Action -eq 'user') { $user | Select-Object login,id; exit }
if ($Action -eq 'list') { $pulls=Invoke-RestMethod -Uri "$api/repos/$repo/pulls?state=open&limit=50" -Headers $headers -TimeoutSec 20; $pulls | ForEach-Object { $_ | Select-Object number,title,html_url,@{n='head';e={$_.head.ref}},@{n='base';e={$_.base.ref}} }; exit }
if ($Action -eq 'push') {
 if ($Branch -notmatch '^improvement/pi(?:/|-autonomous$)') { throw 'Unexpected push branch' }
 $env:PI_GITEA_AGENT_TOKEN=$credential[1]
 try {
  git config --local credential.useHttpPath true
  $agentUrl="http://coding-agent-a01@10.0.2.73:3080/$repo.git"
  $remoteName=if($Owner -eq 'coding-agent-a01') {'agent-fork'} else {'agent'}
  if ((git remote) -contains $remoteName) { if ((git remote get-url $remoteName) -ne $agentUrl) { throw 'Unexpected agent remote' } }
  else { git remote add $remoteName $agentUrl }
  $helper='!f() { if [ "$1" = get ]; then printf "username=coding-agent-a01\npassword=%s\n" "$PI_GITEA_AGENT_TOKEN"; fi; }; f'
  git -c credential.helper= -c "credential.helper=$helper" push $remoteName "${Branch}:refs/heads/$Branch"
  if ($LASTEXITCODE -ne 0) { throw 'Agent push failed' }
 } finally { Remove-Item Env:PI_GITEA_AGENT_TOKEN -ErrorAction SilentlyContinue }
 exit
}
if ($Action -eq 'pr') {
 if ($Branch -notmatch '^improvement/pi(?:/|-autonomous$)' -or $Base -notin @('main','improvement/pi-autonomous')) { throw 'Unexpected PR branch' }
 $pulls=Invoke-RestMethod -Uri "$api/repos/$repo/pulls?state=open&limit=50" -Headers $headers -TimeoutSec 20
 $existing=@($pulls | Where-Object { $_.head.ref -eq $Branch -and $_.base.ref -eq $Base -and (!$HeadOwner -or $_.head.repo.owner.login -eq $HeadOwner) })
 $body=Get-Content -LiteralPath $BodyFile -Raw
 if ($existing) { $result=Invoke-RestMethod -Method Patch -Uri "$api/repos/$repo/pulls/$($existing[0].number)" -Headers $headers -ContentType 'application/json' -Body (@{title=$Title;body=$body}|ConvertTo-Json) }
 else { $headRef=if($HeadOwner) { "${HeadOwner}:$Branch" } else {$Branch}; $result=Invoke-RestMethod -Method Post -Uri "$api/repos/$repo/pulls" -Headers $headers -ContentType 'application/json' -Body (@{head=$headRef;base=$Base;title=$Title;body=$body}|ConvertTo-Json) }
 $result | Select-Object number,html_url,title
}
