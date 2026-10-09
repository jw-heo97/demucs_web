import { createContext, useContext } from "react";

/** 지금 이 기기의 권한. 서버 /api/me 가 정한다 — 화면은 보여 주기만 하고, 막는 것은 서버다. */
export interface Me {
  /** 접속자 관리 탭을 볼 수 있는가 (내 Tailscale 계정 기기·이 PC) */
  admin: boolean;
  /** 바꾸는 요청(저장·삭제·분리 등록…)을 보낼 수 있는가. 보기 전용 기기는 재생·다운로드만 */
  canEdit: boolean;
}

export const MeContext = createContext<Me>({ admin: false, canEdit: true });
export const useMe = () => useContext(MeContext);
