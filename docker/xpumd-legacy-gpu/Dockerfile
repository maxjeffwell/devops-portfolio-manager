# Intel XPUM daemon with Intel's LEGACY Level Zero GPU driver added, for
# integrated graphics older than Xe (Gen8-Gen11, e.g. UHD Graphics 630).
# The stock image only bundles the current Level Zero driver, which does not
# recognise those chips: xpumd logs "failed to initialize L0 Sysman API ...
# ERROR_UNINITIALIZED" and exports no GPU metrics. The legacy driver is a
# separate library (libze_intel_gpu_legacy1.so.1) that sits beside the current
# one; ZE_ENABLE_ALT_DRIVERS lists both, so the same image works on Xe and on
# the older chips.
#
# The base image has no shell or package manager, so the libraries are unpacked
# in a throwaway stage and copied in. Rebuild when the base image is bumped; the
# legacy driver is a frozen branch (compute-runtime 24.35.x), same packages and
# checksums as docker/ovms-legacy-gpu.
ARG BASE=ghcr.io/intel/xpumanager/xpumd:v2.2.0

FROM debian:13-slim AS legacy
ADD --checksum=sha256:c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67 https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-core_1.0.17537.24_amd64.deb /tmp/legacy/
ADD --checksum=sha256:40dfbd15ab62de036a00824b304a2aa1fa2d81ad60ef83da09cfe3c5a80c429f https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-level-zero-gpu-legacy1_1.5.30872.36_amd64.deb /tmp/legacy/
RUN mkdir /out && for f in /tmp/legacy/*.deb; do dpkg -x "$f" /out; done \
 && find /out -name 'libze_intel_gpu_legacy1.so*' | grep -q . \
 && find /out \( -type f -o -type l \) | sort

FROM ${BASE}
COPY --from=legacy /out/usr/ /usr/
ENV ZE_ENABLE_ALT_DRIVERS=libze_intel_gpu.so.1,libze_intel_gpu_legacy1.so.1
