declare namespace UPNG {
    interface Frame {
        rect: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        img: Uint8Array;
        blend: number;
        dispose: number;
        bpp?: number;
        bpl?: number;
    }

    interface DecodedPNG {
        width: number;
        height: number;
        depth: number;
        ctype: number;
        frames: Frame[];
        tabs: {
            [key: string]: any;
            acTL?: {
                num_frames: number;
                num_plays: number;
            };
            pHYs?: number[];
            cHRM?: number[];
            tEXt?: { [key: string]: string };
            zTXt?: { [key: string]: string };
            iTXt?: { [key: string]: string };
            PLTE?: Uint8Array;
            tRNS?: Uint8Array | number | number[];
            gAMA?: number;
            sRGB?: number;
            bKGD?: number[] | number;
        };
        data: Uint8Array;
    }

    interface QuantizeResult {
        abuf: ArrayBuffer;
        inds: Uint8Array;
        plte: {
            est: {
                Cov: number[];
                q: number[];
                e: number[];
                L: number;
                eMq255: number;
                eMq: number;
                rgba: number;
            };
        }[];
    }

    interface CompressOptions {
        ctype?: number;
        depth?: number;
        plte?: number[];
        frames?: Frame[];
    }

    /**
     * Decodes a PNG file into an object containing image data and metadata
     * @param buff - The PNG file buffer to decode
     */
    function decode(buff: ArrayBuffer): DecodedPNG;

    /**
     * Converts decoded PNG data to RGBA8 format
     * @param out - The decoded PNG data
     */
    function toRGBA8(out: DecodedPNG): ArrayBuffer[];

    namespace encode {
        /**
         * Compresses image data into PNG format
         * @param bufs - Array of image data buffers
         * @param w - Image width
         * @param h - Image height
         * @param ps - Palette size (0 for auto)
         * @param dels - Frame delays for animations
         * @param tabs - Additional PNG chunks/metadata
         * @param forbidPlte - Whether to forbid palette usage
         */
        function compress(
            bufs: ArrayBuffer[],
            w: number,
            h: number,
            ps?: number,
            dels?: number[],
            tabs?: { [key: string]: any },
            forbidPlte?: boolean
        ): CompressOptions;

        /**
         * Applies dithering to image data
         * @param sb - Source buffer
         * @param w - Image width
         * @param h - Image height
         * @param plte - Color palette
         * @param tb - Target buffer
         * @param oind - Output indices
         * @param MTD - Dithering method (0: None, 1: Floyd-Steinberg, 2: Bayer)
         */
        function dither(
            sb: Uint8Array,
            w: number,
            h: number,
            plte: number[],
            tb: Uint8Array,
            oind: Uint8Array,
            MTD?: number
        ): void;
    }

    /**
     * Encodes image data into a PNG file
     * @param bufs - Array of image data buffers
     * @param w - Image width
     * @param h - Image height
     * @param ps - Palette size (0 for auto)
     * @param dels - Frame delays for animations
     * @param tabs - Additional PNG chunks/metadata
     * @param forbidPlte - Whether to forbid palette usage
     */
    function encode(
        bufs: ArrayBuffer[],
        w: number,
        h: number,
        ps?: number,
        dels?: number[],
        tabs?: { [key: string]: any },
        forbidPlte?: boolean
    ): ArrayBuffer;

    /**
     * Lossless encoding of PNG data
     * @param bufs - Array of image data buffers
     * @param w - Image width
     * @param h - Image height
     * @param cc - Color channels
     * @param ac - Alpha channel
     * @param depth - Bit depth
     * @param dels - Frame delays for animations
     * @param tabs - Additional PNG chunks/metadata
     */
    function encodeLL(
        bufs: ArrayBuffer[],
        w: number,
        h: number,
        cc: number,
        ac: number,
        depth: number,
        dels?: number[],
        tabs?: { [key: string]: any }
    ): ArrayBuffer;

    /**
     * Quantizes image colors
     * @param abuf - Image buffer to quantize
     * @param ps - Maximum number of colors
     * @param doKmeans - Whether to use k-means clustering
     */
    function quantize(abuf: ArrayBuffer, ps: number, doKmeans?: boolean): QuantizeResult;

    namespace quantize {
        function findNearest(sb: Uint8Array, inds: Uint8Array, plte: Uint8Array): number;

        function getKDtree(nimg: Uint8Array, ps: number, err?: number): [any, any[]];

        function getNearest(nd: any, r: number, g: number, b: number, a: number): any;
    }
}

export = UPNG;
// export as namespace UPNG;
