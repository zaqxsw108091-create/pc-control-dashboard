// 바탕화면·시작 메뉴에 "내 PC 관제 대시보드" 아이콘(바로가기)을 만들거나 지웁니다.
//   node student/install.mjs               아이콘 만들기
//   node student/install.mjs --uninstall   아이콘 지우기
//   node student/install.mjs --status      아이콘이 있는지 확인 (있으면 0, 없으면 1로 끝남)
//
// - 관리자 권한이 필요 없고, 내 계정의 바탕화면·시작 메뉴에 바로가기 파일 2개만 만듭니다.
// - 프로그램을 다른 곳에 복사하거나 레지스트리·실행 정책·보안 설정을 바꾸지 않습니다.
// - 바로가기는 이 폴더의 student\start.bat 을 가리킵니다. 그래서 이 폴더를 옮기거나 지우면 아이콘도 다시 만들어야 해요.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPowerShell } from './collect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHORTCUT_NAME = '내 PC 관제 대시보드';

// PowerShell 명령. 경로는 명령 글자에 섞지 않고 환경 변수로 넘겨서, 폴더 이름에 따옴표·특수문자가 있어도 안전해요.
// WScript.Shell 바로가기 기능은 시스템 언어 밖의 글자(예: 영어 Windows의 한글)를 파일 이름에 못 쓰므로,
// 영문 임시 이름으로 저장한 뒤 한글 이름으로 바꿔요. (Windows CI에서 실제로 확인한 문제)
export const PS_INSTALL = {
  create:
    "$ws = New-Object -ComObject WScript.Shell; $made = @(); foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { if (-not $dir) { continue }; $lnk = Join-Path $dir ($env:PCD_NAME + '.lnk'); $tmp = Join-Path $dir ('pcd-' + [guid]::NewGuid().ToString('N') + '.lnk'); $s = $ws.CreateShortcut($tmp); $s.TargetPath = $env:PCD_TARGET; $s.WorkingDirectory = $env:PCD_WORKDIR; $s.WindowStyle = 7; $s.Description = 'PC Control Dashboard (read-only)'; $s.IconLocation = ($env:SystemRoot + '\\System32\\shell32.dll,15'); $s.Save(); Move-Item -LiteralPath $tmp -Destination $lnk -Force; $made += $lnk }; $made -join [Environment]::NewLine",
  remove:
    "$gone = @(); foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { if (-not $dir) { continue }; $lnk = Join-Path $dir ($env:PCD_NAME + '.lnk'); if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; $gone += $lnk } }; $gone -join [Environment]::NewLine",
  status:
    "$found = @(); foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { if (-not $dir) { continue }; $lnk = Join-Path $dir ($env:PCD_NAME + '.lnk'); if (Test-Path -LiteralPath $lnk) { $found += $lnk } }; $found -join [Environment]::NewLine",
};

export function shortcutEnv(root = path.join(HERE, '..')) {
  return {
    PCD_NAME: SHORTCUT_NAME,
    PCD_TARGET: path.join(root, 'student', 'start.bat'),
    PCD_WORKDIR: root,
  };
}

const lines = (out) => String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export async function runInstall(action = 'create', { platform = process.platform, run = runPowerShell, env = shortcutEnv() } = {}) {
  if (platform !== 'win32') throw new Error('바로가기 만들기는 Windows에서만 할 수 있어요');
  if (action === 'create' && !fs.existsSync(env.PCD_TARGET)) throw new Error(`start.bat 을 찾지 못했어요: ${env.PCD_TARGET}`);
  return lines(await run(PS_INSTALL[action], { env }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const action = args.includes('--uninstall') ? 'remove' : args.includes('--status') ? 'status' : 'create';
  try {
    const paths = await runInstall(action);
    if (action === 'create') {
      console.log('아이콘을 만들었어요:');
      for (const p of paths) console.log(`  ${p}`);
      console.log(`이제 바탕화면이나 시작 메뉴의 "${SHORTCUT_NAME}"을 누르면 켜져요.`);
      console.log('주의: 이 폴더를 옮기거나 지우면 아이콘이 동작하지 않아요. 그때는 새 위치에서 install.bat 을 다시 실행하세요.');
    } else if (action === 'remove') {
      console.log(paths.length ? `아이콘 ${paths.length}개를 지웠어요.` : '지울 아이콘이 없어요.');
      console.log('프로그램 폴더와 조회 기록(student\\data)은 그대로 있어요. 필요 없으면 폴더째 지우면 돼요.');
    } else {
      console.log(paths.length ? `아이콘이 있어요:\n  ${paths.join('\n  ')}` : '아이콘이 없어요.');
      process.exitCode = paths.length ? 0 : 1;
    }
  } catch (e) {
    console.error(`실패했어요: ${e.message}`);
    process.exitCode = 2;
  }
}
