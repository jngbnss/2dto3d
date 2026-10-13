# sixview CAD — 브라우저 3D CAD 편집기

`sixview` 2D→3D 파이프라인에 **추가로 붙인** 웹 CAD 편집 모듈입니다.
기존 CLI·분석·카빙·6면 미리보기 코드는 변경하지 않았고, 서버에 `/cad` 와
`/api/cad/*` 라우트만 **추가**했습니다.

> 핵심 원칙: **미리보기 이미지는 형상이 아닙니다.**
> 6면 렌더가 6장 있어도 3D 메시가 없으면 이 편집기는 가져오기를 거부합니다.
> 그리고 **삼각형 메시는 CAD 솔리드가 아닙니다.** AI 카빙 결과는 메시로만
> 취급하고, 치수 기반 편집·Boolean·STEP 내보내기는 비활성화합니다.

---

## 1. 실행 방법

### 준비 (최초 1회)

```bash
cd cad
npm install        # 또는 프로젝트 루트에서: npm run cad:install
npm run build      # 또는 프로젝트 루트에서: npm run cad:build
```

### 실행

```bash
# 프로젝트 루트에서
node src/cli.ts serve --dir out --port 5173
```

```
웹 미리보기: http://127.0.0.1:5173/
3D 뷰어: http://127.0.0.1:5173/viewer
3D CAD 편집기: http://127.0.0.1:5173/cad
뷰 디렉터리: C:\2dto3d\out
```

* `/` — 기존 6면 분석 미리보기 (우상단에 뷰어·편집기 링크)
* `/viewer` — 색이 입혀진 캐릭터를 360° 돌려 보는 뷰어 (`viewer.html`, 같은 `cad/dist` 빌드)
* `/cad` — 3D CAD 편집기

### 이미지 → 텍스처 3D 모델

```bash
node src/cli.ts run front.png --out out-kitty              # 1장
node src/cli.ts run kitty_six_views_transparent --out out-kitty   # front.png… 가 든 폴더 (첫 장 = 정면)
node src/cli.ts serve --dir out-kitty                      # → /viewer
```

기본 공급자는 `trellis` (Hugging Face Space TRELLIS)입니다. 여러 장을 한 번에
받아 **베이크된 컬러 텍스처가 있는 GLB**를 돌려주므로 정점 색 메시처럼 뭉개지지
않습니다. 결과는 `<out>/model.glb` 와 6면 렌더로 저장되고, 공급자가 -Z를 보는
모델은 텍스처를 건드리지 않고 루트 노드 회전으로 +Z 정면에 맞춥니다.
무료 ZeroGPU 할당량은 `HF_TOKEN` 또는 `huggingface-cli login` 토큰
(`~/.cache/huggingface/token`)이 있으면 계정 할당량으로 늘어납니다.

### 편집기 개발 모드

```bash
node src/cli.ts serve --dir out --port 5173   # 터미널 1: 파이프라인 서버
npm run cad:dev                               # 터미널 2: Vite (http://127.0.0.1:5174/cad/)
```

Vite 개발 서버가 `/api/cad` 와 `/views` 를 파이프라인 서버로 프록시하므로
AI 결과 가져오기가 개발 모드에서도 동작합니다. 대상 서버는 `SIXVIEW_SERVER`
환경 변수로 바꿀 수 있습니다.

---

## 2. CAD 커널 선택

| 후보 | 판단 |
|---|---|
| **replicad 1.1.0 (MIT) + replicad-opencascadejs 1.1.0 (LGPL-2.1)** | **채택.** OpenCascade(OCCT)를 WASM으로 빌드한 진짜 B-rep 커널. Boolean·Fillet·Chamfer·STEP 입출력이 모두 실제 위상 연산. |
| opencascade.js (donalffons) | 동일 커널이지만 전체 빌드가 더 크고 저수준 API를 직접 다뤄야 함. replicad가 같은 커널의 슬림 빌드를 쓰면서 사용성이 훨씬 좋음. |
| CascadeStudio | 코드 기반 CAD 참고용. 애플리케이션이라 라이브러리로 임베드하기에 부적합. 구조만 참고. |
| manifold-3d | 빠르지만 메시 Boolean 전용. B-rep이 없어 STEP을 쓸 수 없으므로 탈락. |

채택 전 실제 커널을 Node에서 검증했습니다 — Boolean 차집합, 회전체(원뿔),
`mesh()`/`meshEdges()` 테셀레이션, `ADVANCED_FACE` 를 포함한 STEP, 이진 STL,
Fillet/Chamfer가 모두 정상 동작함을 확인한 뒤 통합했습니다.

### 역할 분리

```
CADGeometryEngine ──postMessage──> kernel.worker (OCCT/WASM)
   형상의 진실                        Boolean · Extrude · Hole · Fillet · STEP
        │
        │ 삼각형 버퍼 (Transferable)
        ▼
CADRenderer (three.js)   ← 화면 표현만. 형상 계산 일절 없음.
```

* **치수 변경** = feature 파라미터 변경 → 커널 재빌드. (실제 형상 변경)
* **이동·회전** = three.js `Object3D` 변환. 커널 호출 없음. (표시 위치만)
* 솔리드에는 **스케일 기즈모를 제공하지 않습니다.** 솔리드의 크기는
  파라미터이지 표시 배율이 아니기 때문입니다. 스케일은 메시 전용입니다.

---

## 3. 모듈 구성

| 모듈 | 파일 | 역할 |
|---|---|---|
| CADWorkspace | `src/cad/ui/CADWorkspace.tsx` | 레이아웃, 커널 부팅, 단축키, 자동 복원 |
| CADRenderer | `src/cad/render/renderer.ts` | three.js 씬·카메라·그리드·픽킹·기즈모 |
| CADGeometryEngine | `src/cad/engine/geometryEngine.ts` | 워커 수명주기, 요청 상관, 테셀레이션 캐시 |
| (커널) | `src/cad/engine/kernel.worker.ts` | OCCT 형상 연산, LRU 셰이프 캐시 |
| CADObjectManager | `src/cad/core/objectManager.ts` | 객체·그룹·feature 트리 조작 |
| CADSelectionManager | `src/cad/render/renderer.ts` (선택/기즈모 영역) | 선택 하이라이트, 다중 선택 드래그 |
| CADHistoryManager | `src/cad/core/historyManager.ts` | 스냅샷 Undo/Redo |
| CADFileManager | `src/cad/file/fileManager.ts` | STL/GLB/OBJ 입출력, 단위·좌표계 정규화 |
| CADProjectStore | `src/cad/core/projectStore.ts` | 문서 상태, commit/undo, 자동 저장 |
| AI 어댑터 | `src/cad/ai/aiAdapter.ts` | 파이프라인 결과 분류 및 가져오기 |

### 확장 지점

`CADGeometryEngine` 의 요청/응답 프로토콜(`engine/protocol.ts`)과
`AiPipelineAdapter` 인터페이스가 외부 연결 지점입니다. MediaPipe 손동작,
홀로그램 출력, 시뮬레이션, 3D 프린팅 연동은 각각 렌더러 입력 이벤트와
`CADProjectStore` 구독만으로 붙일 수 있도록 상태를 분리해 두었습니다.
**이번 단계에서 구현하지 않았습니다.**

---

## 4. 단위

* 내부 저장 단위는 **항상 mm**. three.js 1 단위 = 1 mm = 커널 1 단위.
* 표시 단위(mm/cm/m/inch)는 UI 경계에서만 변환합니다 (`core/units.ts`).
* 각도는 도(°), 내부 회전은 three.js `XYZ` 오일러 순서. 커널도 같은 순서를
  재현하도록 Z→Y→X 순으로 월드축 회전을 적용합니다. 화면과 STEP 파일의
  방향이 일치하는 이유입니다.

---

## 5. AI 2D→3D 결과 연동

`GET /api/cad/models` 가 `out` 디렉터리 상태를 그대로 보고합니다. 3D 뷰어도
같은 목록을 읽고, 생성 모델(`model.glb`/`model.obj`)을 카빙 결과보다 먼저 보여줍니다.

| 디렉터리 상태 | 보고 | 편집기 동작 |
|---|---|---|
| `carved.obj` 있음 | `asset.kind = "mesh"` | 메시로 가져오기. 이동/회전/스케일/분석/STL·GLB 내보내기 **가능**, 치수 편집·Boolean·STEP **불가** |
| 뷰 PNG만 있음 | `asset = null` | **가져오기 차단.** "이미지 6장은 형상이 아님"을 명시 |
| STEP 자산 | `asset.kind = "solid"` | 완전한 CAD 솔리드로 가져오기 |

카빙 결과는 무차원 좌표계이고 `src/views.ts` 기준 **+Y가 위**입니다.
서버가 `upAxis: "y"`, `normalizeToMm: 100` 을 함께 보고하고, 편집기가
Z-up 변환과 크기 정규화를 **정점에 직접 적용**한 뒤 무엇을 했는지
상태 표시줄에 그대로 알립니다.

---

## 6. 단축키

| 키 | 동작 |
|---|---|
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+S` | 프로젝트 저장 |
| `Ctrl+D` | 복제 |
| `Ctrl+G` | 그룹 |
| `Delete` | 삭제 |
| `1`–`7` | 정면·배면·좌·우·평면·저면·등각 뷰 |
| `F` | 선택 객체에 맞춤 |
| `W` / `E` / `R` | 이동 / 회전 / 스케일 기즈모 |
| `Esc` | 선택 해제 |

---

## 7. 오픈소스 및 라이선스

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| three | 0.186.1 | MIT | 3D 렌더링, 로더/익스포터, 컨트롤 |
| replicad | 1.1.0 | MIT | OCCT 상위 CAD API |
| replicad-opencascadejs | 1.1.0 | **LGPL-2.1-only** | OpenCascade WASM 빌드 (CAD 커널) |
| react / react-dom | 19.x | MIT | UI |
| zustand | 5.x | MIT | 상태 관리 |
| vite | 8.x | MIT | 번들러 |
| typescript | 5.9.x | Apache-2.0 | 타입 검사 |

> **LGPL-2.1 주의.** CAD 커널(`replicad-opencascadejs`)은 LGPL-2.1입니다.
> 수정 없이 별도 WASM 바이너리로 동적 로드해 사용하므로 애플리케이션 코드까지
> LGPL이 전염되지 않지만, 재배포 시 해당 라이선스 고지와 함께
> 커널 교체 가능성(해당 바이너리 대체 권리)을 유지해야 합니다.
> 상용 배포 전 법무 검토를 권장합니다.
> 원 프로젝트: <https://github.com/sgenoud/replicad>, <https://github.com/donalffons/opencascade.js>

참고한 저장소: [opencascade.js](https://github.com/donalffons/opencascade.js),
[CascadeStudio](https://github.com/zalo/CascadeStudio) (구조 참고),
[three.js](https://github.com/mrdoob/three.js).

---

## 8. 구현 완료 / 미완성

### 완료

* 3D 작업 공간: X/Y/Z 축, mm 그리드, 원근/직교 전환, 6면+등각 뷰, 회전·확대·이동,
  선택 하이라이트, 객체별 표시/숨김
* 기본 도형: Box / Cylinder / Sphere / Cone (Cone은 OCCT 회전체로 생성)
* 치수 편집: feature 파라미터 수정 → 커널 재빌드 (표시 배율 아님)
* Extrude: 사각형·원·정다각형·L 프로파일 → 실제 솔리드
* Boolean: Union / Cut / Intersection (실행 **전** 커널 검증 → 실패 시 문서 무변경)
* Hole: 원통 차집합, 관통/깊이 지정, 카운터보어
* Fillet / Chamfer: 전체 모서리
* Feature 트리: Boolean 이후에도 하위 피연산자 치수 재편집 가능
* 부품 관리: 이름 변경, 선택, 이동, 회전, 복제, 삭제, 표시/숨김, 그룹/해제,
  드래그로 그룹에 넣기 (월드 배치 보존)
* Undo / Redo: 형상 연산 포함 스냅샷 방식, 작업 기록 100단계
* 파일: STL·GLB·OBJ 가져오기, STEP 가져오기, STL·GLB·STEP 내보내기,
  프로젝트 저장/열기(JSON, 치수·변환·형상 연산 이력 포함)
* 새로고침 후 IndexedDB 자동 복원
* 무거운 연산 Web Worker 분리, 커널 오류 격리, 패널 단위 ErrorBoundary,
  입력값 검증, 지오메트리 LRU 캐시 및 dispose

### 미완성 / 범위 밖

* **메시 → CAD 솔리드 재구성 없음.** AI 카빙 결과는 끝까지 메시입니다.
  (표면 인식 기반 역설계가 필요하며 별도 단계입니다.)
* 조립 구속조건(Mate/Joint) — 현재는 배치와 그룹만
* 스케치 평면 위 자유 곡선 작도 UI — 프로파일은 사전 정의형 + L 프로파일
* 면/모서리 단위 선택 — Fillet·Chamfer는 전체 모서리에만 적용
* MediaPipe 손동작, 홀로그램 디스플레이, 시뮬레이션, 3D 프린팅 슬라이싱
* STEP 다중 솔리드 분해 — 가져온 STEP은 단일 바디로 취급
