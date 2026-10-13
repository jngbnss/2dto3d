# 호환성 검증

## 유지된 기능

- front/back/left/right/top 업로드
- 원본을 보존하는 rotation/flip/scale/offset/crop
- alpha 또는 경계 배경 키잉 마스크
- GLB, OBJ, voxel GLB 출력
- Studio 3D viewer와 5면 원본/재렌더/충돌 비교
- 기존 `views.json` 읽기
- 기존 결과 파일에 새 해상도 필드가 없을 때 기본값 처리
- CLI `silhouette` 기본 동작 유지

## 추가된 기능

- `크기·중심 자동 보정`: 수동 scale/offset만 초기화하고 공통 XYZ scale 재계산
- `geometry`, `ai`, `hybrid` 복원 방식
- 얇은 접합부 감지 시 제한된 해상도 자동 상향
- 비다양체 감지 시 Manifold level-set fallback
- 정렬/형상/텍스처/색 충돌/메시 토폴로지 분리 점수
- 합성 GT 5종과 `npm run regression`

## 의존성

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---:|---|---|
| `sharp` | 0.35.5 | Apache-2.0 | 이미지 디코드·마스크·PNG. 알려진 high audit 경고 제거 |
| `manifold-3d` | 3.5.4 | Apache-2.0 | 결함 메시의 강건한 level-set 재추출 |

`npm audit --audit-level=high`: 취약점 0개.

## 검증 명령

```bash
npm run typecheck
npm test
npm run regression -- --out tmp/regression-final --size 256 --res 128
npm --prefix cad run build
npm audit --audit-level=high
```

확인 결과: 테스트 33/33 통과, TypeScript 통과, CAD production build 통과, 합성 5종 메시 경계/non-manifold edge 0.

## 남은 한계

- visual hull은 사진에 보이지 않는 오목부 깊이를 결정할 수 없다.
- UV atlas는 미구현. 현재 vertex colour라 작은 로고가 mesh 밀도에 제한된다.
- 부품별 boolean/rig graph는 설계 단계. 현재는 얇은 구조 보존과 manifold fallback까지 구현됐다.
- UniRig는 8GB 이상 VRAM 요구. 현재 6GB GPU에서 검증하지 않아 UI 기능으로 표시하지 않는다.
- TRELLIS 로컬 권장 16GB 이상/Linux. 현재 장비에서는 원격 provider 후보만 현실적이다.
- Stanley 원본 부재. 해당 실물 회귀는 재수집 필요.
