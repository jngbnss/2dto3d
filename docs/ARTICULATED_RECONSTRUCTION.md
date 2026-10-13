# 관절·접합부 복원 전략

## 결론

리깅은 모든 접합부 문제의 선행 해법이 아니다. 입력 실루엣에서 이미 사라진 손잡이 목, 용접부, 얇은 링크를 사후 skeleton/skin weight가 복구하지 못한다.

- 생활용품·기계: 얇은 구조 보존 → 부품 분할 → 부품별 복원 → 접합/boolean → 품질 검증
- 캐릭터·인형·관절 로봇: 위 과정에 skeleton prior와 skinning을 추가
- 변형 없는 최종 CAD: rig는 선택 메타데이터. 형상 점수와 별도 평가

## 현재 구현

`src/reconstruct/detail-resolution.ts`가 각 마스크를 요청 voxel 크기 기준으로 형태학적 opening한다. 약 4셀보다 가는 유의미한 구조가 사라지면 해상도를 1.5배 한 단계 자동 상향한다.

- 최대 384로 제한
- 모든 입력을 무조건 고해상도로 만들지 않음
- 실제 사용 해상도, 요청 해상도, 감지 뷰를 결과와 UI에 표시
- 손잡이·링크·가는 부품을 smoothing 전에 보존

이 방식은 형상을 추측하지 않는다. 다섯 뷰가 확인한 세부만 더 촘촘히 샘플링한다.

## 오픈소스 검토

| 후보 | 용도 | 라이선스/환경 | 결정 |
|---|---|---|---|
| [UniRig](https://github.com/VAST-AI-Research/UniRig) | skeleton + skinning 자동 생성 | MIT, 공식 요구 VRAM 8GB 이상 | 캐릭터/관절 물체용 선택 후처리 후보. 현재 RTX 4050 6GB에서는 기본 설치·실행 안 함 |
| [RigAnything](https://github.com/Isabella98Liu/RigAnything) | 범용 auto-rigging | Adobe Research License, 비상업 연구 제한 | 제품 기본 기능에서 제외 |
| [TRELLIS](https://github.com/microsoft/TRELLIS) | multi-image 3D 후보 | MIT, 로컬 권장 NVIDIA 16GB 이상/Linux | 원격 또는 충분한 GPU 환경의 hybrid 후보 |
| [InstantMesh](https://github.com/TencentARC/InstantMesh) | single-image sparse-view mesh | Apache-2.0, CUDA 12.1/PyTorch 2.1 계열 | front 단일뷰 보조 후보. 5면 정합은 hull 검증 필수 |

## 다음 구현 경로

1. silhouette connected component와 concavity로 부품 후보 생성
2. 뷰 간 부품 대응 그래프 작성
3. rigid joint 후보(고정, 회전, 슬라이드) 추정
4. 각 부품에 visual hull/회전체/돌출/AI 중 최적 방식 적용
5. 겹침 길이와 법선을 기준으로 weld/boolean 후보 비교
6. 캐릭터 계열에서만 UniRig 호환 adapter 실행
7. 최종 메시의 연결성·비다양체 edge·자기 교차와 5면 재투영을 함께 채점

UniRig 도입 조건: 8GB 이상 GPU 또는 원격 worker, 모델 가중치 출처 고정, 라이선스 고지, 동일 입력 회귀 수치 확보. 조건 전에는 UI에서 구현된 기능으로 표시하지 않는다.
