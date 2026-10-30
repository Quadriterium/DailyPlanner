import sharp from 'sharp';

await Promise.all([192, 512].map(size =>
  sharp('public/icon.svg').resize(size, size).png().toFile(`public/icon-${size}.png`),
));
