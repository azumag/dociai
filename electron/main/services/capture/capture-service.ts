type CapturerSource = {
  id: string;
  name: string;
  display_id?: string;
  thumbnail?: { toDataURL(): string };
};

type DesktopCapturerOptions = { types: Array<"screen" | "window">; thumbnailSize: { width: number; height: number }; fetchWindowIcons: boolean };
type DesktopCapturerLike = { getSources(options: DesktopCapturerOptions): Promise<CapturerSource[]> };

export type CaptureSourceSummary = { id: string; name: string; type: "screen" | "window"; displayId: string; thumbnail: string };
export type CaptureStatus = { selectedName: string; preferredName: string; sourceCount: number };

function sourceType(source: Pick<CapturerSource, "id">): "screen" | "window" { return source.id.startsWith("window:") ? "window" : "screen"; }

function summary(source: CapturerSource): CaptureSourceSummary {
  return {
    id: source.id,
    name: source.name.slice(0, 256),
    type: sourceType(source),
    displayId: String(source.display_id ?? ""),
    thumbnail: typeof source.thumbnail?.toDataURL === "function" ? source.thumbnail.toDataURL() : "",
  };
}

// desktopCapturer.getSources (Main-only API) enumeration + selection, backing
// session.setDisplayMediaRequestHandler so Renderer's getDisplayMedia() never needs an OS
// picker (issue #117). Source ids are only stable for a single Electron process lifetime, so
// selection is persisted by name (see setPreferredSourceName), not id.
export class CaptureService {
  #sources = new Map<string, CapturerSource>();
  #selectedId = "";
  #preferredName = "";
  #disposed = false;

  constructor(private readonly desktopCapturer: DesktopCapturerLike) {}

  async listSources(): Promise<CaptureSourceSummary[]> {
    if (this.#disposed) return [];
    const sources = await this.desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false });
    this.#sources = new Map(sources.filter((source) => typeof source?.id === "string" && typeof source?.name === "string").map((source) => [source.id, source]));
    return [...this.#sources.values()].map(summary);
  }

  setPreferredSourceName(name: unknown): void { this.#preferredName = typeof name === "string" ? name.trim().slice(0, 256) : ""; }

  async selectSource({ id = "", name = "" }: { id?: string; name?: string } = {}): Promise<{ selected: true; name: string; type: "screen" | "window" }> {
    if (this.#disposed) throw new Error("capture service is disposed");
    const source = (id && this.#sources.get(id)) ?? [...this.#sources.values()].find((candidate) => candidate.name === name);
    if (!source) throw new Error("capture source was not found; refresh the source list");
    this.#selectedId = source.id; this.#preferredName = source.name;
    return { selected: true, name: source.name, type: sourceType(source) };
  }

  async resolveVideo(): Promise<CapturerSource> {
    await this.listSources();
    const selected = this.#sources.get(this.#selectedId)
      ?? [...this.#sources.values()].find((source) => this.#preferredName && source.name === this.#preferredName)
      ?? [...this.#sources.values()].find((source) => sourceType(source) === "screen")
      ?? [...this.#sources.values()][0];
    if (!selected) throw new Error("no screen capture source is available");
    this.#selectedId = selected.id;
    return selected;
  }

  status(): CaptureStatus { return { selectedName: this.#sources.get(this.#selectedId)?.name ?? "", preferredName: this.#preferredName, sourceCount: this.#sources.size }; }

  dispose(): void { this.#disposed = true; this.#sources.clear(); this.#selectedId = ""; }
}
