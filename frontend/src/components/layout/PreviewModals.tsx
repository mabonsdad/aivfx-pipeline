type ImagePreviewState = { url: string; label: string } | null;
type VideoPreviewState = { url: string; label: string } | null;

type PreviewModalsProps = {
  imagePreview: ImagePreviewState;
  videoPreview: VideoPreviewState;
  onCloseImage: () => void;
  onCloseVideo: () => void;
};

export default function PreviewModals({ imagePreview, videoPreview, onCloseImage, onCloseVideo }: PreviewModalsProps) {
  return (
    <>
      {imagePreview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onCloseImage}>
          <div className="relative flex h-[90vh] w-[90vw] items-center justify-center">
            <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseImage}>
              x
            </button>
            <img src={imagePreview.url} alt={imagePreview.label} className="h-full w-full object-contain" onClick={onCloseImage} />
          </div>
        </div>
      ) : null}

      {videoPreview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onCloseVideo}>
          <div className="relative w-[90vw] max-w-6xl rounded-lg border border-ink/20 bg-black p-3" onClick={(event) => event.stopPropagation()}>
            <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseVideo}>
              x
            </button>
            <video src={videoPreview.url} controls autoPlay preload="metadata" className="h-[80vh] w-full rounded object-contain" />
          </div>
        </div>
      ) : null}
    </>
  );
}
