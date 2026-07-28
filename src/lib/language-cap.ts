/**
 * 세션당 동시 언어(=Gemini Live 브릿지) 개수 상한을 판정하는 순수 로직.
 * 실제 브릿지를 띄우지 않고 단위 테스트할 수 있도록 매니저에서 분리한다.
 */

export class LanguageCapReachedError extends Error {
  readonly openLanguages: string[];
  constructor(openLanguages: string[]) {
    super("Concurrent language limit reached for this session");
    this.name = "LanguageCapReachedError";
    this.openLanguages = openLanguages;
  }
}

/**
 * target 언어를 새로 열 수 있는지 판정한다.
 * - 이미 열려 있으면 재사용이므로 상한과 무관하게 true(새 자리를 쓰지 않음).
 * - 아니면 현재 열린 개수가 max 미만일 때만 true.
 */
export function canOpenLanguage(
  openLanguages: string[],
  target: string,
  max: number
): boolean {
  if (openLanguages.includes(target)) return true;
  return openLanguages.length < max;
}
