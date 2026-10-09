import { createContext, useContext } from "react";

/** 지금 이 기기의 권한. 서버 /api/me 가 정한다 — 화면은 보여 주기만 하고, 막는 것은 서버다. */
export interface Me {
  /** 접속자 관리 탭을 볼 수 있는가 (내 Tailscale 계정 기기·이 PC) */
  admin: boolean;
  /** 바꾸는 요청(저장·삭제·분리 등록…)을 보낼 수 있는가. 보기 전용 기기는 재생·다운로드만 */
  canEdit: boolean;
  /** 나를 가리키는 키 — 송 맵 버전의 owner 와 비교해 '내가 만든 것' 을 안다 */
  key: string;
  /** 접속 링크들 (관리자만 — 보관함에서 곡을 공유할 링크를 고를 때) */
  links: { id: string; label: string }[];
}

export const MeContext = createContext<Me>({ admin: false, canEdit: true, key: "", links: [] });

/** 이 버전을 내가 다룰 수 있는가 (만든 사람이거나 관리자). 주인이 없는 예전 버전은 관리자 것. */
export const ownsVersion = (me: Me, owner: string | null | undefined) =>
  me.admin || (!!owner && owner !== "admin" && owner === me.key);
export const useMe = () => useContext(MeContext);

/** 이 곡을 내가 만들었나 (지우기는 만든 사람·관리자만). 주인 없는 예전 곡은 관리자 것 */
export const ownsJob = (me: Me, owner: string | null | undefined) => ownsVersion(me, owner);
