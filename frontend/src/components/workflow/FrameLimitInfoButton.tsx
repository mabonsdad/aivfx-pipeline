import { InfoDialogButton } from "../layout/UiFeedback";

type FrameLimitRow = {
  model: string;
  maxSeconds: number;
  modelFps: number;
  maxFrameCount: number;
};

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

function FrameLimitTable(props: { title: string; rows: FrameLimitRow[] }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-ink">{props.title}</h4>
      <div className="overflow-x-auto rounded-lg border border-ink/10">
        <table className="min-w-full text-left text-xs text-ink/80">
          <thead className="bg-bg/80 text-ink/70">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Max seconds</th>
              <th className="px-3 py-2 text-right font-medium">Model FPS</th>
              <th className="px-3 py-2 text-right font-medium">Max frame count</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={`${props.title}:${row.model}`} className="border-t border-ink/10">
                <td className="px-3 py-2">{row.model}</td>
                <td className="px-3 py-2 text-right">{row.maxSeconds}</td>
                <td className="px-3 py-2 text-right">{row.modelFps}</td>
                <td className="px-3 py-2 text-right">{row.maxFrameCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function FrameLimitInfoButton(props: { label?: string }) {
  return (
    <InfoDialogButton title="Frame limits" label={props.label ?? "Frame limits"} maxWidthClassName="max-w-5xl">
      <div className="space-y-5 text-sm leading-6 text-ink/80">
        <p>
          If you are using a video input above the frame limits below you will need to extend it in Post Processing.
        </p>
        <FrameLimitTable title="First frame + video input → video" rows={START_VIDEO_ROWS} />
        <FrameLimitTable title="First frame + last frame → video" rows={START_END_ROWS} />
        <FrameLimitTable title="First frame → video" rows={START_ONLY_ROWS} />
        <p>
          Most models lose a few frames from the start of the generation and some the last frame, so it may be best to
          generate a slightly longer clip than what you need.
        </p>
      </div>
    </InfoDialogButton>
  );
}
