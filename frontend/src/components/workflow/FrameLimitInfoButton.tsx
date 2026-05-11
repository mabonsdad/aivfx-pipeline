import { InfoDialogButton } from "../layout/UiFeedback";

type FrameLimitRow = {
  model: string;
  maxSeconds: number;
  modelFps: number;
  maxFrameCount: number;
};

type GenerateInputMode = "start_video" | "start_end" | "start_only";

const START_VIDEO_ROWS: FrameLimitRow[] = [
  { model: "Luma Ray 2 Flash", maxSeconds: 10, modelFps: 24, maxFrameCount: 240 },
  { model: "Luma Ray 2", maxSeconds: 10, modelFps: 24, maxFrameCount: 240 },
  { model: "Happy Horse 1.0 Video Edit", maxSeconds: 15, modelFps: 24, maxFrameCount: 360 },
  { model: "Runway Gen 4 Aleph", maxSeconds: 5, modelFps: 24, maxFrameCount: 120 },
  { model: "Kling O1 Edit", maxSeconds: 30, modelFps: 30, maxFrameCount: 900 },
  { model: "Kling 3.0 Omni", maxSeconds: 15, modelFps: 60, maxFrameCount: 900 },
  { model: "Seedance 2.0", maxSeconds: 15, modelFps: 24, maxFrameCount: 360 },
  { model: "Wan 2.2 Animate", maxSeconds: 5, modelFps: 24, maxFrameCount: 120 },
  { model: "Wan 2.7 VideoEdit", maxSeconds: 10, modelFps: 30, maxFrameCount: 300 },
];

const START_END_ROWS: FrameLimitRow[] = [
  { model: "Kling 2.6", maxSeconds: 10, modelFps: 48, maxFrameCount: 480 },
  { model: "LTX 2.3 Pro", maxSeconds: 10, modelFps: 24, maxFrameCount: 240 },
  { model: "Veo 3.1", maxSeconds: 8, modelFps: 24, maxFrameCount: 192 },
  { model: "Veo 3.1 Fast", maxSeconds: 8, modelFps: 24, maxFrameCount: 192 },
  { model: "Seedance 2.0", maxSeconds: 15, modelFps: 24, maxFrameCount: 360 },
  { model: "Wan 2.7 I2V", maxSeconds: 15, modelFps: 30, maxFrameCount: 450 },
];

const START_ONLY_ROWS: FrameLimitRow[] = [
  { model: "Wan 2.2 A14B", maxSeconds: 5, modelFps: 16, maxFrameCount: 80 },
  { model: "Happy Horse 1.0 Image to Video", maxSeconds: 15, modelFps: 24, maxFrameCount: 360 },
  { model: "Runway Gen 4.5", maxSeconds: 10, modelFps: 24, maxFrameCount: 240 },
  { model: "Kling 2.6", maxSeconds: 10, modelFps: 48, maxFrameCount: 480 },
  { model: "Veo 3.1", maxSeconds: 8, modelFps: 24, maxFrameCount: 192 },
  { model: "Veo 3.1 Fast", maxSeconds: 8, modelFps: 24, maxFrameCount: 192 },
  { model: "Seedance 2.0", maxSeconds: 15, modelFps: 24, maxFrameCount: 360 },
  { model: "Wan 2.7 I2V", maxSeconds: 15, modelFps: 30, maxFrameCount: 450 },
  { model: "Sora 2.0", maxSeconds: 15, modelFps: 24, maxFrameCount: 360 },
];

function FrameLimitTable(props: { rows: FrameLimitRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink/10">
      <table className="min-w-full text-left text-[11px] leading-5 text-ink/80">
          <thead className="bg-bg/80 text-ink/70">
            <tr>
              <th className="px-2 py-1.5 font-medium">Model</th>
              <th className="px-2 py-1.5 text-right font-medium">Secs</th>
              <th className="px-2 py-1.5 text-right font-medium">FPS</th>
              <th className="px-2 py-1.5 text-right font-medium">Frames</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.model} className="border-t border-ink/10">
                <td className="px-2 py-1.5">{row.model}</td>
                <td className="px-2 py-1.5 text-right">{row.maxSeconds}</td>
                <td className="px-2 py-1.5 text-right">{row.modelFps}</td>
                <td className="px-2 py-1.5 text-right">{row.maxFrameCount}</td>
              </tr>
            ))}
          </tbody>
      </table>
    </div>
  );
}

function modeTitle(mode: GenerateInputMode): string {
  if (mode === "start_video") return "First frame + video input to video";
  if (mode === "start_end") return "First frame + last frame to video";
  return "First frame to video";
}

function rowsForMode(mode: GenerateInputMode): FrameLimitRow[] {
  if (mode === "start_video") return START_VIDEO_ROWS;
  if (mode === "start_end") return START_END_ROWS;
  return START_ONLY_ROWS;
}

export default function FrameLimitInfoButton(props: { label?: string; mode: GenerateInputMode }) {
  const rows = rowsForMode(props.mode);
  return (
    <InfoDialogButton title="Frame limits" label={props.label ?? "Frame limits"} maxWidthClassName="max-w-3xl">
      <div className="space-y-4 text-sm leading-6 text-ink/80">
        <p>
          If you are above these limits, generate in parts and extend later in Post Process.
        </p>
        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-ink">{modeTitle(props.mode)}</h4>
          <FrameLimitTable rows={rows} />
        </section>
        <p>Most models lose a few frames at the start, and sometimes at the end, so it can help to generate slightly long.</p>
      </div>
    </InfoDialogButton>
  );
}
