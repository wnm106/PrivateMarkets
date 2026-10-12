'use client';

import Image from 'next/image';

/** tapestr.ai brand logo using the official logo image */
export function BrandLogo({ size = 34 }: { size?: number }) {
  // Logo aspect ratio is approximately 3.2:1 (width:height)
  const width = Math.round(size * 3.2);
  
  return (
    <span className="brand-logo">
      <Image
        src="/tapestrai.jpg"
        alt="tapestr.ai"
        width={width}
        height={size}
        style={{ objectFit: 'contain' }}
        priority
        unoptimized
      />
    </span>
  );
}
