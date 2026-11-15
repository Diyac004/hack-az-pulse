# AgOpenWeb headless tractor, one container = one tractor.
# Build context = a checkout of https://github.com/AgOpenGPS-Official/AgOpenWeb (NOT this repo):
#   docker build -f agopenweb-bridge/Dockerfile -t agopenweb:headless <path-to-AgOpenWeb>
# Only official Microsoft .NET images are used. The build fetches NuGet packages from nuget.org and
# the SHA-256-pinned SharpIsoTerm .nupkg from its GitHub release (Shared/AgOpenWeb.VirtualTerminal).

# ---- build ---------------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
WORKDIR /src
COPY . .
# Same flags as deploy/linux/package.sh, but framework-dependent (the runtime image carries .NET).
# DesktopOnly=true -> net10.0 only (no iOS/Android TFMs). Untrimmed: the app uses reflection.
RUN dotnet publish Platforms/AgOpenWeb.Desktop/AgOpenWeb.Desktop.csproj \
      -c Release -p:DesktopOnly=true -p:PublishTrimmed=false -p:PublishSingleFile=false \
      -o /app

# ---- runtime -------------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/runtime:10.0
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    AGOPENWEB_DATA=/data
COPY --from=build /app /app
# Non-root; /data holds Fields/ and settings (mount a host folder to share fields across tractors).
RUN mkdir -p /data && chown -R app:app /data
USER app
WORKDIR /app
EXPOSE 5174
# --headless: display-less daemon (no Avalonia/Photino window); the web UI + WS live on :5174.
ENTRYPOINT ["dotnet", "AgOpenWeb.Desktop.dll", "--headless"]
