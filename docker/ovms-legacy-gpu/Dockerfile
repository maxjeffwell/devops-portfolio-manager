# OpenVINO Model Server with Intel's LEGACY GPU driver added, for integrated
# graphics older than Xe (Gen8-Gen11, e.g. UHD Graphics 630). The stock -gpu image
# only bundles the current driver, which does not recognise those chips, so the
# server reports "Available devices: CPU" on them. The legacy packages install
# beside the current driver (separate ICD entry and Level Zero library); OpenVINO
# uses whichever one recognises the GPU in the machine.
#
# Rebuild when the base image is bumped. The legacy driver itself is a frozen
# branch (compute-runtime 24.35.x).
ARG BASE=openvino/model_server:2026.4.1-gpu
FROM ${BASE}
USER root
ADD --checksum=sha256:c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67 https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-core_1.0.17537.24_amd64.deb /tmp/legacy/
ADD --checksum=sha256:dd016400f87fa2b6a9fa9fbcca7eb4a2629174a29de679709f9bec5cede88b0e https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-opencl_1.0.17537.24_amd64.deb /tmp/legacy/
ADD --checksum=sha256:bbe71e4f414259e06a10cde72c29a2bd78d41b2bb2f6f8463b1806797fe66e85 https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb /tmp/legacy/
ADD --checksum=sha256:40dfbd15ab62de036a00824b304a2aa1fa2d81ad60ef83da09cfe3c5a80c429f https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-level-zero-gpu-legacy1_1.5.30872.36_amd64.deb /tmp/legacy/
RUN dpkg -i /tmp/legacy/*.deb && rm -rf /tmp/legacy \
 && test -f /etc/OpenCL/vendors/intel_legacy1.icd && test -f /etc/OpenCL/vendors/intel.icd
USER ovms
