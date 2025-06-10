const RE_YOUTUBE =
  /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT =
  /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

export class YoutubeTranscriptError extends Error {
  constructor(message) {
    super(`[YoutubeTranscript] 🚨 ${message}`);
  }
}

export class YoutubeTranscriptTooManyRequestError extends YoutubeTranscriptError {
  constructor() {
    super(
      'YouTube is receiving too many requests from this IP and now requires solving a captcha to continue'
    );
  }
}

export class YoutubeTranscriptVideoUnavailableError extends YoutubeTranscriptError {
  constructor(videoId: string) {
    super(`The video is no longer available (${videoId})`);
  }
}

export class YoutubeTranscriptDisabledError extends YoutubeTranscriptError {
  constructor(videoId: string) {
    super(`Transcript is disabled on this video (${videoId})`);
  }
}

export class YoutubeTranscriptNotAvailableError extends YoutubeTranscriptError {
  constructor(videoId: string) {
    super(`No transcripts are available for this video (${videoId})`);
  }
}

export class YoutubeTranscriptNotAvailableLanguageError extends YoutubeTranscriptError {
  constructor(lang: string, availableLangs: string[], videoId: string) {
    super(
      `No transcripts are available in ${lang} this video (${videoId}). Available languages: ${availableLangs.join(
        ', '
      )}`
    );
  }
}

export interface TranscriptConfig {
  lang?: string;
}
export interface TranscriptResponse {
  text: string;
  duration: number;
  offset: number;
  lang?: string;
}

/**
 * Class to retrieve transcript if exist
 */
export class YoutubeTranscript {
  /**
   * Fetch transcript from YTB Video
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  public static async fetchTranscript(
    videoId: string,
    config?: TranscriptConfig
  ): Promise<TranscriptResponse[]> {
    const identifier = this.retrieveVideoId(videoId);
    
        // Try HTML parsing first (original battle-tested method)
    let captions;
    try {
      const videoPageResponse = await fetch(
        `https://www.youtube.com/watch?v=${identifier}`,
        {
          headers: {
            ...(config?.lang && { 'Accept-Language': config.lang }),
            'User-Agent': USER_AGENT,
          },
        }
      );
      const videoPageBody = await videoPageResponse.text();

      const splittedHTML = videoPageBody.split('"captions":');

      if (splittedHTML.length <= 1) {
        if (videoPageBody.includes('class="g-recaptcha"')) {
          throw new YoutubeTranscriptTooManyRequestError();
        }
        if (!videoPageBody.includes('"playabilityStatus":')) {
          throw new YoutubeTranscriptVideoUnavailableError(videoId);
        }
        throw new YoutubeTranscriptDisabledError(videoId);
      }

      captions = (() => {
        try {
          return JSON.parse(
            splittedHTML[1].split(',"videoDetails')[0].replace('\n', '')
          );
        } catch (e) {
          // Fallback: use regex to extract captions object
          const altMatch = videoPageBody.match(/"captions":\s*({[^}]+})/);
          if (altMatch) {
            return JSON.parse(altMatch[1]);
          }
          return undefined;
        }
      })()?.['playerCaptionsTracklistRenderer'];
    } catch (e) {
      // HTML parsing failed completely, will try InnerTube API fallback
      captions = null;
    }



    if (!captions) {
      throw new YoutubeTranscriptDisabledError(videoId);
    }

    if (!('captionTracks' in captions)) {
      throw new YoutubeTranscriptNotAvailableError(videoId);
    }

    if (
      config?.lang &&
      !captions.captionTracks.some(
        (track) => track.languageCode === config?.lang
      )
    ) {
      throw new YoutubeTranscriptNotAvailableLanguageError(
        config?.lang,
        captions.captionTracks.map((track) => track.languageCode),
        videoId
      );
    }

    const transcriptURL = (
      config?.lang
        ? captions.captionTracks.find(
            (track) => track.languageCode === config?.lang
          )
        : captions.captionTracks[0]
    ).baseUrl;

    const transcriptResponse = await fetch(transcriptURL, {
      headers: {
        ...(config?.lang && { 'Accept-Language': config.lang }),
        'User-Agent': USER_AGENT,
      },
    });
    if (!transcriptResponse.ok) {
      throw new YoutubeTranscriptNotAvailableError(videoId);
    }
    const transcriptBody = await transcriptResponse.text();
    
    // If transcript body is empty, the HTML parsing method failed (YouTube security update)
    // Try InnerTube API as fallback
    if (transcriptBody.length === 0) {
      try {
        const InnerTubeApiResponse = await fetch(
          'https://www.youtube.com/youtubei/v1/player',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
              'Referer': `https://www.youtube.com/watch?v=${identifier}`,
              'Origin': 'https://www.youtube.com',
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: 'WEB',
                  clientVersion: '2.20241211.01.00',
                },
              },
              videoId: identifier,
            }),
          }
        );
        
        if (InnerTubeApiResponse.ok) {
          const innerTubeData = await InnerTubeApiResponse.json();
          const innerTubeCaptions = innerTubeData?.captions?.playerCaptionsTracklistRenderer;
          
          if (innerTubeCaptions && innerTubeCaptions.captionTracks) {
            const innerTubeTranscriptURL = (
              config?.lang
                ? innerTubeCaptions.captionTracks.find(
                    (track) => track.languageCode === config?.lang
                  )
                : innerTubeCaptions.captionTracks[0]
            ).baseUrl;
            
            const innerTubeTranscriptResponse = await fetch(innerTubeTranscriptURL, {
              headers: {
                ...(config?.lang && { 'Accept-Language': config.lang }),
                'User-Agent': USER_AGENT,
                'Referer': `https://www.youtube.com/watch?v=${identifier}`,
              },
            });
            
            if (innerTubeTranscriptResponse.ok) {
              const innerTubeTranscriptBody = await innerTubeTranscriptResponse.text();
              if (innerTubeTranscriptBody.length > 0) {
                const results = [...innerTubeTranscriptBody.matchAll(RE_XML_TRANSCRIPT)];
                return results.map((result) => ({
                  text: result[3],
                  duration: parseFloat(result[2]),
                  offset: parseFloat(result[1]),
                  lang: config?.lang ?? innerTubeCaptions.captionTracks[0].languageCode,
                }));
              }
            }
          }
        }
      } catch (e) {
        // InnerTube fallback failed, continue with original error
      }
      throw new YoutubeTranscriptNotAvailableError(videoId);
    }
    
    const results = [...transcriptBody.matchAll(RE_XML_TRANSCRIPT)];
    return results.map((result) => ({
      text: result[3],
      duration: parseFloat(result[2]),
      offset: parseFloat(result[1]),
      lang: config?.lang ?? captions.captionTracks[0].languageCode,
    }));
  }

  /**
   * Retrieve video id from url or string
   * @param videoId video url or video id
   */
  private static retrieveVideoId(videoId: string) {
    if (videoId.length === 11) {
      return videoId;
    }
    const matchId = videoId.match(RE_YOUTUBE);
    if (matchId && matchId.length) {
      return matchId[1];
    }
    throw new YoutubeTranscriptError(
      'Impossible to retrieve Youtube video ID.'
    );
  }
}
