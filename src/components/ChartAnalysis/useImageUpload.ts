import { useState, useCallback, useRef, useEffect } from 'react';
import type { UploadedImage } from './types';
import { CHART_LABELS } from './types';

export function useImageUpload() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [replaceTargetIndex, setReplaceTargetIndex] = useState<number | null>(
    null,
  );

  // Revoke any remaining object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.preview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, []);

  const addImage = useCallback(
    (file: File) => {
      if (images.length >= 8) return;
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = URL.createObjectURL(file);
      setImages((prev) => {
        const usedLabels = new Set(prev.map((i) => i.label));
        const nextLabel =
          CHART_LABELS.find((l) => !usedLabels.has(l)) ?? CHART_LABELS[0];
        return [...prev, { id, file, preview, label: nextLabel }];
      });
    },
    [images.length],
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clearAllImages = useCallback(() => {
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.preview);
      return [];
    });
  }, []);

  const updateLabel = useCallback((id: string, label: string) => {
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, label } : i)));
  }, []);

  const replaceImage = useCallback((index: number) => {
    setReplaceTargetIndex(index);
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || replaceTargetIndex == null) return;
      setImages((prev) => {
        const targetIdx = replaceTargetIndex - 1;
        if (targetIdx < 0 || targetIdx >= prev.length) return prev;
        const old = prev[targetIdx]!;
        URL.revokeObjectURL(old.preview);
        const newImg: UploadedImage = {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          preview: URL.createObjectURL(file),
          label: old.label,
        };
        return [
          ...prev.slice(0, targetIdx),
          newImg,
          ...prev.slice(targetIdx + 1),
        ];
      });
      setReplaceTargetIndex(null);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    },
    [replaceTargetIndex],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith('image/'),
      );
      for (const f of files.slice(0, 8 - images.length)) addImage(f);
    },
    [addImage, images.length],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      for (const f of files.slice(0, 8 - images.length)) addImage(f);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [addImage, images.length],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) addImage(file);
        }
      }
    },
    [addImage],
  );

  // Register document-level paste listener
  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  return {
    images,
    fileInputRef,
    replaceInputRef,
    addImage,
    removeImage,
    clearAllImages,
    updateLabel,
    replaceImage,
    handleReplaceFile,
    handleDrop,
    handleFileSelect,
  };
}
