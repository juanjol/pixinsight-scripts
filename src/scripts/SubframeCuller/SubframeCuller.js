/*
 * SubframeCuller.js
 *
 * Measures a folder of light frames and helps you decide which ones to throw
 * away.
 *
 *  - Scans a folder (optionally recursively) for light frames.
 *  - Measures them with the SubframeSelector process: FWHM, eccentricity,
 *    SNR, background level, noise, star count, star residual, altitude...
 *    Frames are measured in batches, so SubframeSelector spreads them over
 *    every core, and the measurement can be restricted to a central region
 *    of the frame to make it several times faster.
 *  - Every measured variable can filter the frames, either with absolute
 *    limits or with a k-sigma clip around the robust median of the batch.
 *  - The file list is coloured in real time: green for the frames that are
 *    kept, red for the ones that are rejected, and the statistics of the
 *    selection are updated as the limits change.
 *  - Individual frames can be pinned so that the filters never touch them.
 *  - Accepting the selection moves the rejected frames to a subfolder and,
 *    optionally, writes a CSV file with every measurement.
 *
 * Requires PixInsight 1.8.8 or later.
 *
 * Copyright (c) 2026. Released under the MIT License.
 */

#feature-id    Toolbox > Subframe Culler

#feature-info  Measures a folder of light frames with SubframeSelector and lets \
               you cull them interactively: absolute or k-sigma limits on FWHM, \
               eccentricity, SNR, background and the rest of the measured \
               variables, with the file list coloured in real time and the \
               rejected frames moved to a subfolder.

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/NumericControl.jsh>

#define TITLE        "Subframe Culler"
#define VERSION      "1.1.0"
#define SETTINGS_KEY "SubframeCuller/settings"

#define COLOR_KEEP   0xff1e8f3e
#define COLOR_REJECT 0xffc62828
#define COLOR_PINNED 0xff1565c0

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

/*
 * Process enumerations live in the global namespace only when the module that
 * defines them is installed, so every one of them is read defensively.
 */
function enumValue( name, fallback )
{
   try
   {
      var v = eval( name );
      if ( typeof v == "number" )
         return v;
   }
   catch ( x )
   {
   }
   return fallback;
}

function isFiniteNumber( x )
{
   return typeof x == "number" && isFinite( x );
}

function median( values )
{
   if ( values.length == 0 )
      return 0;
   var a = values.slice().sort( function( p, q ) { return p - q; } );
   var n = a.length;
   return (n & 1) ? a[(n - 1) >> 1] : (a[n/2 - 1] + a[n/2])/2;
}

/*
 * Robust dispersion: the median absolute deviation scaled to match the
 * standard deviation of a normal distribution. A batch where every frame
 * measures the same would give zero, so the plain standard deviation is used
 * as a fallback to keep the k-sigma limits meaningful.
 */
function madSigma( values, med )
{
   if ( values.length < 2 )
      return 0;
   var d = [];
   for ( var i = 0; i < values.length; ++i )
      d.push( Math.abs( values[i] - med ) );
   var s = 1.4826*median( d );
   if ( s > 0 )
      return s;
   var sum = 0;
   for ( var j = 0; j < values.length; ++j )
      sum += (values[j] - med)*(values[j] - med);
   return Math.sqrt( sum/(values.length - 1) );
}

function fileNameOf( path )
{
   var i = path.lastIndexOf( '/' );
   return (i < 0) ? path : path.substring( i + 1 );
}

function directoryOf( path )
{
   var i = path.lastIndexOf( '/' );
   return (i < 0) ? "" : path.substring( 0, i );
}

function fmt( value, precision )
{
   return isFiniteNumber( value ) ? format( "%.*f", precision, value ) : "-";
}

// ----------------------------------------------------------------------------
// Measured variables
//
// Every entry is one column of the file list and one row of the criteria
// panel. "higherIsBetter" only drives the tool tips and the suggested bound,
// the limits themselves are always explicit.
// ----------------------------------------------------------------------------

function M( key, title, precision, defaultBound, tip )
{
   return { key: key, title: title, precision: precision,
            defaultBound: defaultBound, tip: tip };
}

var METRICS = [
   M( "fwhm", "FWHM", 3, "max",
      "Star size. Rejects the frames blurred by seeing, focus drift or wind." ),
   M( "eccentricity", "Eccentricity", 4, "max",
      "Star elongation, 0 is a perfect circle. Rejects tracking errors." ),
   M( "snrWeight", "SNR", 3, "min",
      "Signal to noise estimate. Rejects the frames taken through clouds or " +
      "in bright twilight." ),
   M( "median", "Background", 6, "max",
      "Median of the frame, in the chosen data unit. Rises with moonlight, " +
      "light pollution, clouds and sky glow." ),
   M( "noise", "Noise", 6, "max",
      "Noise estimate of the frame." ),
   M( "stars", "Stars", 0, "min",
      "Number of stars fitted. A sudden drop means clouds or a bad frame." ),
   M( "starResidual", "Star residual", 4, "max",
      "How well the stars fit the PSF model. High values mean trailing or " +
      "distorted stars." ),
   M( "fwhmMeanDev", "FWHM dev", 4, "max",
      "Dispersion of the FWHM across the frame. High values mean uneven " +
      "focus or optical problems." ),
   M( "eccentricityMeanDev", "Ecc dev", 4, "max",
      "Dispersion of the eccentricity across the frame." ),
   M( "altitude", "Altitude", 2, "min",
      "Altitude of the target above the horizon, when the header provides " +
      "it. Low frames suffer more extinction and worse seeing." ),
   M( "weight", "Weight", 4, "min",
      "Weight computed by SubframeSelector with its own expression." )
];

function metricByKey( key )
{
   for ( var i = 0; i < METRICS.length; ++i )
      if ( METRICS[i].key == key )
         return METRICS[i];
   return null;
}

// Columns of the file list.
var LIST_COLUMNS = [ "fwhm", "eccentricity", "snrWeight", "median", "noise",
                     "stars", "starResidual", "altitude" ];

// ----------------------------------------------------------------------------
// The measurements table of SubframeSelector
//
// The table grew with the PSF signal estimators of PixInsight 1.8.9, so the
// layout is chosen by the number of columns. The first seven fields have
// never moved, which is what makes the fallback usable.
// ----------------------------------------------------------------------------

var LAYOUT_COMMON = [ "index", "enabled", "locked", "path", "weight", "fwhm",
                      "eccentricity" ];

var LAYOUT_1_8_8 = LAYOUT_COMMON.concat(
   [ "snrWeight", "median", "medianMeanDev", "noise", "noiseRatio", "stars",
     "starResidual", "fwhmMeanDev", "eccentricityMeanDev",
     "starResidualMeanDev", "azimuth", "altitude" ] );

var LAYOUT_1_8_9 = LAYOUT_COMMON.concat(
   [ "psfSignalWeight", "psfSNR", "psfScale", "psfScaleSNR", "psfFlux",
     "psfFluxPower", "psfTotalMeanFlux", "psfTotalMeanPowerFlux", "psfCount",
     "mStar", "nStar", "snrWeight", "median", "medianMeanDev", "noise",
     "noiseRatio", "stars", "starResidual", "fwhmMeanDev",
     "eccentricityMeanDev", "starResidualMeanDev", "azimuth", "altitude" ] );

function layoutFor( columns )
{
   if ( columns == LAYOUT_1_8_9.length )
      return LAYOUT_1_8_9;
   if ( columns == LAYOUT_1_8_8.length )
      return LAYOUT_1_8_8;
   return null;
}

function rowToMeasurement( row )
{
   var layout = layoutFor( row.length );
   var m = {};
   if ( layout == null )
   {
      // Unknown build: keep the fields that have never changed position.
      layout = LAYOUT_COMMON;
      m.partial = true;
   }
   for ( var i = 0; i < layout.length && i < row.length; ++i )
      m[layout[i]] = row[i];

   // Older builds have no PSF SNR, newer ones report both estimators.
   if ( !isFiniteNumber( m.snrWeight ) && isFiniteNumber( m.psfSNR ) )
      m.snrWeight = m.psfSNR;

   m.path = String( m.path );
   m.fileName = fileNameOf( m.path );
   m.pinned = false;      // ignored by the filters
   m.pinnedKeep = true;   // what the pin forces
   m.keep = true;
   m.reasons = [];
   return m;
}

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

function defaultCriteria()
{
   var c = {};
   for ( var i = 0; i < METRICS.length; ++i )
   {
      var metric = METRICS[i];
      c[metric.key] = {
         enabled:  metric.key == "fwhm" || metric.key == "eccentricity",
         mode:     "sigma",          // "sigma" or "absolute"
         useLow:   metric.defaultBound == "min",
         useHigh:  metric.defaultBound == "max",
         low:      0,
         high:     0,
         kLow:     2,
         kHigh:    2
      };
   }
   return c;
}

function defaultSettings()
{
   return {
      version:        1,
      inputDirectory: "",
      filter:         "*.xisf;*.fit;*.fits;*.fts",
      recursive:      false,
      subframeScale:  1.0,      // arcseconds per pixel
      cameraGain:     1.0,      // electrons per data number
      scaleUnit:      0,        // 0 arcseconds, 1 pixels
      dataUnit:       0,        // 0 electrons, 1 data numbers
      structureLayers:5,
      noiseLayers:    0,
      hotPixelFilter: true,
      pedestal:       0,
      fileCache:      true,
      batchSize:      16,       // frames sent to SubframeSelector at once
      maxPSFFits:     0,        // 0 leaves the default of the process
      useROI:         false,
      roiPercent:     50,       // side of the central region, per cent
      rejectsFolder:  "rejects",
      writeCSV:       true,
      criteria:       defaultCriteria()
   };
}

function loadSettings()
{
   var settings = defaultSettings();
   try
   {
      var json = Settings.read( SETTINGS_KEY, DataType_String );
      if ( Settings.lastReadOK && json != null && json.length > 0 )
      {
         var stored = JSON.parse( json );
         for ( var key in settings )
            if ( key != "criteria" && stored[key] !== undefined )
               settings[key] = stored[key];
         if ( stored.criteria )
            for ( var k in settings.criteria )
               if ( stored.criteria[k] )
                  for ( var f in settings.criteria[k] )
                     if ( stored.criteria[k][f] !== undefined )
                        settings.criteria[k][f] = stored.criteria[k][f];
      }
   }
   catch ( x )
   {
      console.warningln( TITLE + ": stored settings ignored: " + x );
   }
   return settings;
}

function saveSettings( settings )
{
   try
   {
      Settings.write( SETTINGS_KEY, DataType_String, JSON.stringify( settings ) );
   }
   catch ( x )
   {
      console.warningln( TITLE + ": settings could not be saved: " + x );
   }
}

var settings = loadSettings();

// ----------------------------------------------------------------------------
// Scanning and measuring
// ----------------------------------------------------------------------------

function scanDirectory( directory, filter, recursive )
{
   var patterns = filter.split( ';' );
   var paths = [];
   var seen = {};
   for ( var i = 0; i < patterns.length; ++i )
   {
      var pattern = patterns[i].trim();
      if ( pattern.length == 0 )
         continue;
      var found = searchDirectory( directory + '/' + pattern, recursive );
      for ( var j = 0; j < found.length; ++j )
         if ( !seen[found[j]] )
         {
            seen[found[j]] = true;
            paths.push( found[j] );
         }
   }
   return paths.sort();
}

function newSubframeSelector( paths, roi )
{
   var P = new SubframeSelector;

   P.routine = enumValue( "SubframeSelectorRoutine_MeasureSubframes", 0 );

   // The shape of the subframes table changed between versions, so the widest
   // form is tried first and the assignment is narrowed until one is accepted.
   var rows4 = [], rows3 = [], rows2 = [];
   for ( var i = 0; i < paths.length; ++i )
   {
      rows4.push( [ true, paths[i], "", "" ] );
      rows3.push( [ true, paths[i], "" ] );
      rows2.push( [ true, paths[i] ] );
   }
   var assigned = false;
   var candidates = [ rows4, rows3, rows2 ];
   for ( var c = 0; c < candidates.length && !assigned; ++c )
      try
      {
         P.subframes = candidates[c];
         assigned = true;
      }
      catch ( x )
      {
      }
   if ( !assigned )
      throw new Error( "The SubframeSelector process rejected the file list." );

   P.subframeScale = settings.subframeScale;
   P.cameraGain = settings.cameraGain;
   P.scaleUnit = settings.scaleUnit;
   P.dataUnit = settings.dataUnit;
   P.structureLayers = settings.structureLayers;
   P.noiseLayers = settings.noiseLayers;
   P.applyHotPixelFilter = settings.hotPixelFilter;
   P.fileCache = settings.fileCache;

   // Only present in some versions.
   try { P.pedestal = settings.pedestal; } catch ( x ) {}
   try { P.nonInteractive = true; } catch ( x ) {}
   try { P.outputDirectory = ""; } catch ( x ) {}

   // Fitting every star of a rich field is the slowest part of a measurement
   // and buys very little once there are a few hundred of them.
   if ( settings.maxPSFFits > 0 )
      try { P.maxPSFFits = settings.maxPSFFits; } catch ( x ) {}

   // Measuring a central region instead of the whole frame is the single
   // biggest saving: the cost drops with the measured area.
   if ( roi != null )
      try
      {
         P.roiX0 = roi.x0;
         P.roiY0 = roi.y0;
         P.roiX1 = roi.x1;
         P.roiY1 = roi.y1;
      }
      catch ( x )
      {
         console.warningln( "This build of SubframeSelector has no region of " +
                            "interest, the whole frame is measured." );
      }

   return P;
}

/*
 * Geometry of a frame, read from the header alone: no pixel data is decoded,
 * so it costs nothing next to a measurement.
 */
function imageGeometry( path )
{
   try
   {
      var fileFormat = new FileFormat( File.extractExtension( path ), true, false );
      if ( fileFormat.isNull )
         return null;
      var file = new FileFormatInstance( fileFormat );
      if ( file.isNull )
         return null;
      var description = file.open( path, "" );
      file.close();
      if ( description == null || description.length == 0 )
         return null;
      return { width: description[0].info.width,
               height: description[0].info.height };
   }
   catch ( x )
   {
      return null;
   }
}

/*
 * Central region covering the requested percentage of the side of the frame.
 */
function centralROI( geometry, percent )
{
   var f = Math.min( 1.0, Math.max( 0.05, percent/100 ) );
   var w = Math.max( 64, Math.round( geometry.width*f ) );
   var h = Math.max( 64, Math.round( geometry.height*f ) );
   var x0 = Math.round( (geometry.width - w)/2 );
   var y0 = Math.round( (geometry.height - h)/2 );
   return { x0: x0, y0: y0, x1: x0 + w, y1: y0 + h };
}

/*
 * Measures a group of frames in a single execution. SubframeSelector reads and
 * measures the frames of one execution in parallel, so a batch is far faster
 * than the same frames one by one; the batch size is what trades that
 * parallelism for the granularity of the progress report and of the stop
 * button. The measurement cache makes a second pass over the same folder
 * almost immediate.
 */
function measureBatch( paths, roi )
{
   var P = newSubframeSelector( paths, roi );
   if ( !P.executeGlobal() )
      return [];
   var table = P.measurements;
   if ( table == null )
      return [];

   var result = [];
   for ( var i = 0; i < table.length; ++i )
   {
      var m = rowToMeasurement( table[i] );
      if ( m.path.length == 0 )
      {
         // Some builds return an empty path; the rows keep the input order.
         m.path = (i < paths.length) ? paths[i] : "";
         m.fileName = fileNameOf( m.path );
      }
      result.push( m );
   }
   return result;
}

// ----------------------------------------------------------------------------
// Filtering
// ----------------------------------------------------------------------------

/*
 * Robust centre and dispersion of every metric over the whole batch, used by
 * the k-sigma limits and by the statistics panel.
 */
function computeStatistics( measurements )
{
   var stats = {};
   for ( var i = 0; i < METRICS.length; ++i )
   {
      var key = METRICS[i].key;
      var values = [];
      for ( var j = 0; j < measurements.length; ++j )
      {
         var v = measurements[j][key];
         if ( isFiniteNumber( v ) )
            values.push( v );
      }
      if ( values.length == 0 )
      {
         stats[key] = null;
         continue;
      }
      var med = median( values );
      stats[key] = {
         count:  values.length,
         median: med,
         sigma:  madSigma( values, med ),
         min:    Math.min.apply( null, values ),
         max:    Math.max.apply( null, values )
      };
   }
   return stats;
}

/*
 * Effective limits of one metric, in the units of the metric, whatever the
 * mode is. Returns null when the metric cannot filter anything.
 */
function limitsOf( key, stats )
{
   var c = settings.criteria[key];
   if ( !c.enabled )
      return null;
   if ( !c.useLow && !c.useHigh )
      return null;

   var low = null, high = null;
   if ( c.mode == "absolute" )
   {
      if ( c.useLow )
         low = c.low;
      if ( c.useHigh )
         high = c.high;
   }
   else
   {
      var s = stats[key];
      if ( s == null )
         return null;
      if ( c.useLow )
         low = s.median - c.kLow*s.sigma;
      if ( c.useHigh )
         high = s.median + c.kHigh*s.sigma;
   }
   return { low: low, high: high };
}

function applyFilters( measurements, stats )
{
   var limits = {};
   for ( var i = 0; i < METRICS.length; ++i )
      limits[METRICS[i].key] = limitsOf( METRICS[i].key, stats );

   for ( var j = 0; j < measurements.length; ++j )
   {
      var m = measurements[j];
      m.reasons = [];

      if ( m.pinned )
      {
         m.keep = m.pinnedKeep;
         continue;
      }

      for ( var k = 0; k < METRICS.length; ++k )
      {
         var metric = METRICS[k];
         var lim = limits[metric.key];
         if ( lim == null )
            continue;
         var v = m[metric.key];
         if ( !isFiniteNumber( v ) )
            continue;
         if ( lim.low != null && v < lim.low )
            m.reasons.push( format( "%s %.*f < %.*f", metric.title,
                                    metric.precision, v,
                                    metric.precision, lim.low ) );
         else if ( lim.high != null && v > lim.high )
            m.reasons.push( format( "%s %.*f > %.*f", metric.title,
                                    metric.precision, v,
                                    metric.precision, lim.high ) );
      }
      m.keep = m.reasons.length == 0;
   }
   return limits;
}

// ----------------------------------------------------------------------------
// One row of the criteria panel
// ----------------------------------------------------------------------------

function CriterionRow( parent, metric, onChanged )
{
   this.metric = metric;
   this.criterion = settings.criteria[metric.key];

   var self = this;

   this.enabled_Check = new CheckBox( parent );
   this.enabled_Check.text = metric.title;
   this.enabled_Check.checked = this.criterion.enabled;
   this.enabled_Check.toolTip = metric.tip;
   this.enabled_Check.setScaledMinWidth( 130 );
   this.enabled_Check.onCheck = function( checked )
   {
      self.criterion.enabled = checked;
      self.updateEnabledState();
      onChanged();
   };

   this.mode_Combo = new ComboBox( parent );
   this.mode_Combo.addItem( "k-sigma" );
   this.mode_Combo.addItem( "absolute" );
   this.mode_Combo.currentItem = (this.criterion.mode == "absolute") ? 1 : 0;
   this.mode_Combo.setScaledFixedWidth( 90 );
   this.mode_Combo.toolTip =
      "<p><b>k-sigma</b>: the limits follow the batch. They are placed at " +
      "k times the robust dispersion (MAD) around the median of the measured " +
      "frames, so a night of bad seeing is culled relative to itself.</p>" +
      "<p><b>absolute</b>: the limits are the values typed below, the same " +
      "for every session.</p>";
   this.mode_Combo.onItemSelected = function( item )
   {
      self.criterion.mode = (item == 1) ? "absolute" : "sigma";
      self.updateEnabledState();
      onChanged();
   };

   this.low_Check = new CheckBox( parent );
   this.low_Check.text = "min";
   this.low_Check.checked = this.criterion.useLow;
   this.low_Check.toolTip = "Reject the frames below the lower limit.";
   this.low_Check.onCheck = function( checked )
   {
      self.criterion.useLow = checked;
      self.updateEnabledState();
      onChanged();
   };

   this.low_Edit = new Edit( parent );
   this.low_Edit.setScaledFixedWidth( 80 );
   this.low_Edit.toolTip = "Lower limit, or k below the median in k-sigma mode.";
   this.low_Edit.onEditCompleted = function()
   {
      var v = parseFloat( this.text );
      if ( !isFinite( v ) )
      {
         self.updateEdits();
         return;
      }
      if ( self.criterion.mode == "absolute" )
         self.criterion.low = v;
      else
         self.criterion.kLow = Math.max( 0, v );
      self.updateEdits();
      onChanged();
   };

   this.high_Check = new CheckBox( parent );
   this.high_Check.text = "max";
   this.high_Check.checked = this.criterion.useHigh;
   this.high_Check.toolTip = "Reject the frames above the upper limit.";
   this.high_Check.onCheck = function( checked )
   {
      self.criterion.useHigh = checked;
      self.updateEnabledState();
      onChanged();
   };

   this.high_Edit = new Edit( parent );
   this.high_Edit.setScaledFixedWidth( 80 );
   this.high_Edit.toolTip = "Upper limit, or k above the median in k-sigma mode.";
   this.high_Edit.onEditCompleted = function()
   {
      var v = parseFloat( this.text );
      if ( !isFinite( v ) )
      {
         self.updateEdits();
         return;
      }
      if ( self.criterion.mode == "absolute" )
         self.criterion.high = v;
      else
         self.criterion.kHigh = Math.max( 0, v );
      self.updateEdits();
      onChanged();
   };

   this.effective_Label = new Label( parent );
   this.effective_Label.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   this.effective_Label.setScaledMinWidth( 230 );
   this.effective_Label.toolTip =
      "Limits actually in use and median of the batch.";

   this.sizer = new HorizontalSizer;
   this.sizer.spacing = 4;
   this.sizer.add( this.enabled_Check );
   this.sizer.add( this.mode_Combo );
   this.sizer.add( this.low_Check );
   this.sizer.add( this.low_Edit );
   this.sizer.add( this.high_Check );
   this.sizer.add( this.high_Edit );
   this.sizer.addSpacing( 6 );
   this.sizer.add( this.effective_Label, 100 );

   this.updateEdits = function()
   {
      var c = this.criterion;
      if ( c.mode == "absolute" )
      {
         this.low_Edit.text = format( "%.*f", this.metric.precision, c.low );
         this.high_Edit.text = format( "%.*f", this.metric.precision, c.high );
      }
      else
      {
         this.low_Edit.text = format( "%.2f", c.kLow );
         this.high_Edit.text = format( "%.2f", c.kHigh );
      }
   };

   this.updateEnabledState = function()
   {
      var on = this.criterion.enabled;
      this.mode_Combo.enabled = on;
      this.low_Check.enabled = on;
      this.high_Check.enabled = on;
      this.low_Edit.enabled = on && this.criterion.useLow;
      this.high_Edit.enabled = on && this.criterion.useHigh;
      this.low_Check.checked = this.criterion.useLow;
      this.high_Check.checked = this.criterion.useHigh;
   };

   /*
    * Shows where the limits landed once the batch is known, which is the only
    * way to read a k-sigma setting.
    */
   this.updateEffective = function( limits, stats )
   {
      var s = stats ? stats[this.metric.key] : null;
      if ( s == null )
      {
         this.effective_Label.text = "not measured";
         return;
      }
      var p = this.metric.precision;
      var text = format( "median %.*f", p, s.median );
      var lim = limits ? limits[this.metric.key] : null;
      if ( lim != null )
      {
         var lo = (lim.low != null) ? format( "%.*f", p, lim.low ) : "-inf";
         var hi = (lim.high != null) ? format( "%.*f", p, lim.high ) : "+inf";
         text += "   keep [" + lo + ", " + hi + "]";
      }
      this.effective_Label.text = text;
   };

   /*
    * Absolute limits start at the measured range so that the first move of the
    * user is a refinement and not a setup.
    */
   this.seedAbsoluteLimits = function( stats )
   {
      var s = stats ? stats[this.metric.key] : null;
      if ( s == null )
         return;
      if ( this.criterion.low == 0 && this.criterion.high == 0 )
      {
         this.criterion.low = s.min;
         this.criterion.high = s.max;
         this.updateEdits();
      }
   };

   this.updateEdits();
   this.updateEnabledState();
}

// ----------------------------------------------------------------------------
// Dialog
// ----------------------------------------------------------------------------

function SubframeCullerDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   var self = this;

   this.windowTitle = TITLE + " " + VERSION;
   this.measurements = [];
   this.stats = {};
   this.limits = {};
   this.aborted = false;
   this.measuring = false;

   // --- Input folder ---------------------------------------------------------

   this.directory_Label = new Label( this );
   this.directory_Label.text = "Lights folder:";
   this.directory_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.directory_Label.setScaledMinWidth( 90 );

   this.directory_Edit = new Edit( this );
   this.directory_Edit.text = settings.inputDirectory;
   this.directory_Edit.toolTip = "Folder holding the light frames to inspect.";
   this.directory_Edit.onEditCompleted = function()
   {
      settings.inputDirectory = this.text.trim();
   };

   this.browse_Button = new ToolButton( this );
   this.browse_Button.icon = this.scaledResource( ":/icons/select-file.png" );
   this.browse_Button.setScaledFixedSize( 22, 22 );
   this.browse_Button.toolTip = "Select the folder.";
   this.browse_Button.onClick = function()
   {
      var gdd = new GetDirectoryDialog;
      gdd.caption = "Select the lights folder";
      if ( settings.inputDirectory.length > 0 )
         gdd.initialPath = settings.inputDirectory;
      if ( gdd.execute() )
      {
         settings.inputDirectory = gdd.directory;
         self.directory_Edit.text = gdd.directory;
      }
   };

   this.directory_Sizer = new HorizontalSizer;
   this.directory_Sizer.spacing = 4;
   this.directory_Sizer.add( this.directory_Label );
   this.directory_Sizer.add( this.directory_Edit, 100 );
   this.directory_Sizer.add( this.browse_Button );

   this.filter_Label = new Label( this );
   this.filter_Label.text = "File filter:";
   this.filter_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.filter_Label.setScaledMinWidth( 90 );

   this.filter_Edit = new Edit( this );
   this.filter_Edit.text = settings.filter;
   this.filter_Edit.setScaledMinWidth( 220 );
   this.filter_Edit.toolTip = "Wildcards separated by semicolons.";
   this.filter_Edit.onEditCompleted = function()
   {
      settings.filter = this.text.trim();
   };

   this.recursive_Check = new CheckBox( this );
   this.recursive_Check.text = "Include subfolders";
   this.recursive_Check.checked = settings.recursive;
   this.recursive_Check.onCheck = function( checked )
   {
      settings.recursive = checked;
   };

   this.measure_Button = new PushButton( this );
   this.measure_Button.text = "Measure";
   this.measure_Button.icon = this.scaledResource( ":/icons/execute.png" );
   this.measure_Button.toolTip =
      "Scan the folder and measure every frame with SubframeSelector.";
   this.measure_Button.onClick = function()
   {
      self.measureAll();
   };

   this.abort_Button = new PushButton( this );
   this.abort_Button.text = "Stop";
   this.abort_Button.icon = this.scaledResource( ":/icons/stop.png" );
   this.abort_Button.enabled = false;
   this.abort_Button.toolTip = "Stop measuring and keep what has been measured.";
   this.abort_Button.onClick = function()
   {
      self.aborted = true;
   };

   this.scan_Sizer = new HorizontalSizer;
   this.scan_Sizer.spacing = 6;
   this.scan_Sizer.add( this.filter_Label );
   this.scan_Sizer.add( this.filter_Edit );
   this.scan_Sizer.addSpacing( 6 );
   this.scan_Sizer.add( this.recursive_Check );
   this.scan_Sizer.addStretch();
   this.scan_Sizer.add( this.measure_Button );
   this.scan_Sizer.add( this.abort_Button );

   this.input_Group = new GroupBox( this );
   this.input_Group.title = "Input";
   this.input_Group.sizer = new VerticalSizer;
   this.input_Group.sizer.margin = 6;
   this.input_Group.sizer.spacing = 4;
   this.input_Group.sizer.add( this.directory_Sizer );
   this.input_Group.sizer.add( this.scan_Sizer );

   // --- Measurement settings -------------------------------------------------

   this.scale_Numeric = new NumericEdit( this );
   this.scale_Numeric.label.text = "Subframe scale:";
   this.scale_Numeric.label.setScaledMinWidth( 90 );
   this.scale_Numeric.setRange( 0.01, 100 );
   this.scale_Numeric.setPrecision( 3 );
   this.scale_Numeric.setValue( settings.subframeScale );
   this.scale_Numeric.toolTip =
      "Arcseconds per pixel. Only used to report FWHM in arcseconds.";
   this.scale_Numeric.onValueUpdated = function( value )
   {
      settings.subframeScale = value;
   };

   this.gain_Numeric = new NumericEdit( this );
   this.gain_Numeric.label.text = "Camera gain:";
   this.gain_Numeric.setRange( 0.0001, 1000 );
   this.gain_Numeric.setPrecision( 4 );
   this.gain_Numeric.setValue( settings.cameraGain );
   this.gain_Numeric.toolTip =
      "Electrons per data number. Only used to report signal in electrons.";
   this.gain_Numeric.onValueUpdated = function( value )
   {
      settings.cameraGain = value;
   };

   this.scaleUnit_Label = new Label( this );
   this.scaleUnit_Label.text = "Scale unit:";
   this.scaleUnit_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.scaleUnit_Combo = new ComboBox( this );
   this.scaleUnit_Combo.addItem( "arcseconds" );
   this.scaleUnit_Combo.addItem( "pixels" );
   this.scaleUnit_Combo.currentItem = settings.scaleUnit;
   this.scaleUnit_Combo.onItemSelected = function( item )
   {
      settings.scaleUnit = item;
   };

   this.dataUnit_Label = new Label( this );
   this.dataUnit_Label.text = "Data unit:";
   this.dataUnit_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.dataUnit_Combo = new ComboBox( this );
   this.dataUnit_Combo.addItem( "electrons" );
   this.dataUnit_Combo.addItem( "data numbers" );
   this.dataUnit_Combo.currentItem = settings.dataUnit;
   this.dataUnit_Combo.onItemSelected = function( item )
   {
      settings.dataUnit = item;
   };

   this.units_Sizer = new HorizontalSizer;
   this.units_Sizer.spacing = 6;
   this.units_Sizer.add( this.scale_Numeric );
   this.units_Sizer.addSpacing( 8 );
   this.units_Sizer.add( this.gain_Numeric );
   this.units_Sizer.addSpacing( 8 );
   this.units_Sizer.add( this.scaleUnit_Label );
   this.units_Sizer.add( this.scaleUnit_Combo );
   this.units_Sizer.addSpacing( 8 );
   this.units_Sizer.add( this.dataUnit_Label );
   this.units_Sizer.add( this.dataUnit_Combo );
   this.units_Sizer.addStretch();

   this.structure_Numeric = new NumericEdit( this );
   this.structure_Numeric.label.text = "Structure layers:";
   this.structure_Numeric.label.setScaledMinWidth( 90 );
   this.structure_Numeric.setRange( 1, 8 );
   this.structure_Numeric.setPrecision( 0 );
   this.structure_Numeric.setValue( settings.structureLayers );
   this.structure_Numeric.toolTip =
      "Wavelet layers used by the star detector. Raise it for undersampled " +
      "frames with very small stars.";
   this.structure_Numeric.onValueUpdated = function( value )
   {
      settings.structureLayers = Math.round( value );
   };

   this.noiseLayers_Numeric = new NumericEdit( this );
   this.noiseLayers_Numeric.label.text = "Noise layers:";
   this.noiseLayers_Numeric.setRange( 0, 4 );
   this.noiseLayers_Numeric.setPrecision( 0 );
   this.noiseLayers_Numeric.setValue( settings.noiseLayers );
   this.noiseLayers_Numeric.toolTip =
      "Wavelet layers removed as noise before detecting stars.";
   this.noiseLayers_Numeric.onValueUpdated = function( value )
   {
      settings.noiseLayers = Math.round( value );
   };

   this.hotPixel_Check = new CheckBox( this );
   this.hotPixel_Check.text = "Hot pixel filter";
   this.hotPixel_Check.checked = settings.hotPixelFilter;
   this.hotPixel_Check.toolTip =
      "Removes hot pixels before detecting stars. Leave it on for " +
      "uncalibrated frames.";
   this.hotPixel_Check.onCheck = function( checked )
   {
      settings.hotPixelFilter = checked;
   };

   this.cache_Check = new CheckBox( this );
   this.cache_Check.text = "Use the measurement cache";
   this.cache_Check.checked = settings.fileCache;
   this.cache_Check.toolTip =
      "Reuses the measurements of frames already measured, which makes a " +
      "second pass almost immediate.";
   this.cache_Check.onCheck = function( checked )
   {
      settings.fileCache = checked;
   };

   this.detection_Sizer = new HorizontalSizer;
   this.detection_Sizer.spacing = 6;
   this.detection_Sizer.add( this.structure_Numeric );
   this.detection_Sizer.addSpacing( 8 );
   this.detection_Sizer.add( this.noiseLayers_Numeric );
   this.detection_Sizer.addSpacing( 8 );
   this.detection_Sizer.add( this.hotPixel_Check );
   this.detection_Sizer.addSpacing( 8 );
   this.detection_Sizer.add( this.cache_Check );
   this.detection_Sizer.addStretch();

   // --- Speed ----------------------------------------------------------------

   this.batch_Numeric = new NumericEdit( this );
   this.batch_Numeric.label.text = "Frames per batch:";
   this.batch_Numeric.label.setScaledMinWidth( 90 );
   this.batch_Numeric.setRange( 1, 512 );
   this.batch_Numeric.setPrecision( 0 );
   this.batch_Numeric.setValue( settings.batchSize );
   this.batch_Numeric.toolTip =
      "<p>Frames handed to SubframeSelector in a single execution. The " +
      "process reads and measures the frames of one execution in parallel, " +
      "so larger batches use every core and are much faster.</p>" +
      "<p>The progress report and the Stop button only act between batches, " +
      "which is the reason not to send the whole folder at once.</p>";
   this.batch_Numeric.onValueUpdated = function( value )
   {
      settings.batchSize = Math.round( value );
   };

   this.maxFits_Numeric = new NumericEdit( this );
   this.maxFits_Numeric.label.text = "Max PSF fits:";
   this.maxFits_Numeric.setRange( 0, 100000 );
   this.maxFits_Numeric.setPrecision( 0 );
   this.maxFits_Numeric.setValue( settings.maxPSFFits );
   this.maxFits_Numeric.toolTip =
      "<p>Upper limit on the stars fitted per frame. Fitting is the slowest " +
      "part of a measurement and a few hundred stars already give a stable " +
      "FWHM and eccentricity, so lowering this speeds up rich fields a " +
      "lot.</p><p>Zero keeps the default of the process.</p>";
   this.maxFits_Numeric.onValueUpdated = function( value )
   {
      settings.maxPSFFits = Math.round( value );
   };

   this.roi_Check = new CheckBox( this );
   this.roi_Check.text = "Central region only:";
   this.roi_Check.checked = settings.useROI;
   this.roi_Check.toolTip =
      "<p>Measures a centred region of every frame instead of the whole " +
      "frame. The cost drops with the measured area, so half the side is " +
      "about four times faster.</p>" +
      "<p>FWHM, eccentricity and background then describe the centre of the " +
      "field, which is what usually decides whether a frame is worth " +
      "keeping, but corner problems go unnoticed.</p>";
   this.roi_Check.onCheck = function( checked )
   {
      settings.useROI = checked;
      self.roi_Numeric.enabled = checked;
   };

   this.roi_Numeric = new NumericEdit( this );
   this.roi_Numeric.label.visible = false;
   this.roi_Numeric.setRange( 5, 100 );
   this.roi_Numeric.setPrecision( 0 );
   this.roi_Numeric.setValue( settings.roiPercent );
   this.roi_Numeric.enabled = settings.useROI;
   this.roi_Numeric.toolTip = "Side of the central region, as a percentage.";
   this.roi_Numeric.onValueUpdated = function( value )
   {
      settings.roiPercent = Math.round( value );
   };

   this.roiPercent_Label = new Label( this );
   this.roiPercent_Label.text = "% of the frame";
   this.roiPercent_Label.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.speed_Sizer = new HorizontalSizer;
   this.speed_Sizer.spacing = 6;
   this.speed_Sizer.add( this.batch_Numeric );
   this.speed_Sizer.addSpacing( 8 );
   this.speed_Sizer.add( this.maxFits_Numeric );
   this.speed_Sizer.addSpacing( 8 );
   this.speed_Sizer.add( this.roi_Check );
   this.speed_Sizer.add( this.roi_Numeric );
   this.speed_Sizer.add( this.roiPercent_Label );
   this.speed_Sizer.addStretch();

   this.measure_Group = new GroupBox( this );
   this.measure_Group.title = "Measurement";
   this.measure_Group.sizer = new VerticalSizer;
   this.measure_Group.sizer.margin = 6;
   this.measure_Group.sizer.spacing = 4;
   this.measure_Group.sizer.add( this.units_Sizer );
   this.measure_Group.sizer.add( this.detection_Sizer );
   this.measure_Group.sizer.add( this.speed_Sizer );

   // --- Criteria -------------------------------------------------------------

   this.criteria_Group = new GroupBox( this );
   this.criteria_Group.title = "Rejection criteria";
   this.criteria_Group.sizer = new VerticalSizer;
   this.criteria_Group.sizer.margin = 6;
   this.criteria_Group.sizer.spacing = 2;

   this.rows = [];
   for ( var i = 0; i < METRICS.length; ++i )
   {
      var row = new CriterionRow( this.criteria_Group, METRICS[i],
                                  function() { self.refresh(); } );
      this.rows.push( row );
      this.criteria_Group.sizer.add( row.sizer );
   }

   this.resetCriteria_Button = new PushButton( this.criteria_Group );
   this.resetCriteria_Button.text = "Reset criteria";
   this.resetCriteria_Button.toolTip = "Go back to the default criteria.";
   this.resetCriteria_Button.onClick = function()
   {
      settings.criteria = defaultCriteria();
      for ( var i = 0; i < self.rows.length; ++i )
      {
         var r = self.rows[i];
         r.criterion = settings.criteria[r.metric.key];
         r.enabled_Check.checked = r.criterion.enabled;
         r.mode_Combo.currentItem = (r.criterion.mode == "absolute") ? 1 : 0;
         r.updateEdits();
         r.updateEnabledState();
         r.seedAbsoluteLimits( self.stats );
      }
      self.refresh();
   };

   this.criteriaButtons_Sizer = new HorizontalSizer;
   this.criteriaButtons_Sizer.addStretch();
   this.criteriaButtons_Sizer.add( this.resetCriteria_Button );
   this.criteria_Group.sizer.addSpacing( 4 );
   this.criteria_Group.sizer.add( this.criteriaButtons_Sizer );

   // --- File list ------------------------------------------------------------

   this.tree = new TreeBox( this );
   this.tree.alternateRowColor = true;
   this.tree.headerVisible = true;
   this.tree.multipleSelection = true;
   this.tree.rootDecoration = false;
   this.tree.setScaledMinSize( 700, 240 );
   this.tree.numberOfColumns = 2 + LIST_COLUMNS.length;
   this.tree.setHeaderText( 0, "File" );
   for ( var c = 0; c < LIST_COLUMNS.length; ++c )
   {
      var metric = metricByKey( LIST_COLUMNS[c] );
      this.tree.setHeaderText( c + 1, metric.title );
      this.tree.setHeaderAlignment( c + 1, TextAlign_Right | TextAlign_VertCenter );
   }
   this.tree.setHeaderText( this.tree.numberOfColumns - 1, "Status" );
   this.tree.onNodeDoubleClicked = function( node )
   {
      self.togglePin( [ node ] );
   };

   this.pin_Button = new PushButton( this );
   this.pin_Button.text = "Pin / unpin";
   this.pin_Button.toolTip =
      "<p>Pins the selected frames to their current state, so the filters no " +
      "longer change them. Pinning again releases them. Double clicking a row " +
      "does the same.</p>";
   this.pin_Button.onClick = function()
   {
      self.togglePin( self.tree.selectedNodes );
   };

   this.forceKeep_Button = new PushButton( this );
   this.forceKeep_Button.text = "Force keep";
   this.forceKeep_Button.toolTip = "Pin the selected frames as kept.";
   this.forceKeep_Button.onClick = function()
   {
      self.forcePin( self.tree.selectedNodes, true );
   };

   this.forceReject_Button = new PushButton( this );
   this.forceReject_Button.text = "Force reject";
   this.forceReject_Button.toolTip = "Pin the selected frames as rejected.";
   this.forceReject_Button.onClick = function()
   {
      self.forcePin( self.tree.selectedNodes, false );
   };

   this.clearPins_Button = new PushButton( this );
   this.clearPins_Button.text = "Clear pins";
   this.clearPins_Button.toolTip = "Give every frame back to the filters.";
   this.clearPins_Button.onClick = function()
   {
      for ( var i = 0; i < self.measurements.length; ++i )
         self.measurements[i].pinned = false;
      self.refresh();
   };

   this.sort_Label = new Label( this );
   this.sort_Label.text = "Sort by:";
   this.sort_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.sort_Combo = new ComboBox( this );
   this.sort_Combo.addItem( "File name" );
   for ( var s = 0; s < METRICS.length; ++s )
      this.sort_Combo.addItem( METRICS[s].title );
   this.sort_Combo.onItemSelected = function()
   {
      self.rebuildTree();
   };

   this.listButtons_Sizer = new HorizontalSizer;
   this.listButtons_Sizer.spacing = 6;
   this.listButtons_Sizer.add( this.pin_Button );
   this.listButtons_Sizer.add( this.forceKeep_Button );
   this.listButtons_Sizer.add( this.forceReject_Button );
   this.listButtons_Sizer.add( this.clearPins_Button );
   this.listButtons_Sizer.addStretch();
   this.listButtons_Sizer.add( this.sort_Label );
   this.listButtons_Sizer.add( this.sort_Combo );

   this.list_Group = new GroupBox( this );
   this.list_Group.title = "Frames";
   this.list_Group.sizer = new VerticalSizer;
   this.list_Group.sizer.margin = 6;
   this.list_Group.sizer.spacing = 4;
   this.list_Group.sizer.add( this.tree, 100 );
   this.list_Group.sizer.add( this.listButtons_Sizer );

   // --- Statistics -----------------------------------------------------------

   this.stats_Label = new Label( this );
   this.stats_Label.frameStyle = FrameStyle_Sunken;
   this.stats_Label.margin = 6;
   this.stats_Label.wordWrapping = true;
   this.stats_Label.useRichText = true;
   this.stats_Label.text = "<p>No frames measured yet.</p>";

   this.stats_Group = new GroupBox( this );
   this.stats_Group.title = "Selection";
   this.stats_Group.sizer = new VerticalSizer;
   this.stats_Group.sizer.margin = 6;
   this.stats_Group.sizer.add( this.stats_Label );

   // --- Output ---------------------------------------------------------------

   this.rejects_Label = new Label( this );
   this.rejects_Label.text = "Rejects subfolder:";
   this.rejects_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.rejects_Edit = new Edit( this );
   this.rejects_Edit.text = settings.rejectsFolder;
   this.rejects_Edit.setScaledFixedWidth( 160 );
   this.rejects_Edit.toolTip =
      "Subfolder of every frame's own folder where the rejected files are " +
      "moved to.";
   this.rejects_Edit.onEditCompleted = function()
   {
      var name = this.text.trim();
      if ( name.length == 0 )
      {
         name = "rejects";
         this.text = name;
      }
      settings.rejectsFolder = name;
   };

   this.csv_Check = new CheckBox( this );
   this.csv_Check.text = "Write a CSV with every measurement";
   this.csv_Check.checked = settings.writeCSV;
   this.csv_Check.onCheck = function( checked )
   {
      settings.writeCSV = checked;
   };

   this.output_Sizer = new HorizontalSizer;
   this.output_Sizer.spacing = 6;
   this.output_Sizer.add( this.rejects_Label );
   this.output_Sizer.add( this.rejects_Edit );
   this.output_Sizer.addSpacing( 8 );
   this.output_Sizer.add( this.csv_Check );
   this.output_Sizer.addStretch();

   // --- Dialog buttons -------------------------------------------------------

   this.apply_Button = new PushButton( this );
   this.apply_Button.text = "Move rejected";
   this.apply_Button.icon = this.scaledResource( ":/icons/ok.png" );
   this.apply_Button.toolTip =
      "Move every rejected frame to the rejects subfolder.";
   this.apply_Button.onClick = function()
   {
      self.moveRejected();
   };

   this.close_Button = new PushButton( this );
   this.close_Button.text = "Close";
   this.close_Button.icon = this.scaledResource( ":/icons/close.png" );
   this.close_Button.onClick = function()
   {
      saveSettings( settings );
      self.hide();
   };

   this.buttons_Sizer = new HorizontalSizer;
   this.buttons_Sizer.spacing = 6;
   this.buttons_Sizer.addStretch();
   this.buttons_Sizer.add( this.apply_Button );
   this.buttons_Sizer.add( this.close_Button );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.input_Group );
   this.sizer.add( this.measure_Group );
   this.sizer.add( this.criteria_Group );
   this.sizer.add( this.list_Group, 100 );
   this.sizer.add( this.stats_Group );
   this.sizer.add( this.output_Sizer );
   this.sizer.add( this.buttons_Sizer );

   this.adjustToContents();
   this.setScaledMinSize( 900, 700 );

   // --------------------------------------------------------------------------
   // Behaviour
   // --------------------------------------------------------------------------

   this.setBusy = function( busy )
   {
      this.measuring = busy;
      this.measure_Button.enabled = !busy;
      this.abort_Button.enabled = busy;
      this.apply_Button.enabled = !busy;
      this.close_Button.enabled = !busy;
      this.directory_Edit.enabled = !busy;
      this.browse_Button.enabled = !busy;
      this.filter_Edit.enabled = !busy;
      this.recursive_Check.enabled = !busy;
      this.measure_Group.enabled = !busy;
      this.criteria_Group.enabled = !busy;
      this.list_Group.enabled = !busy;
   };

   this.measureAll = function()
   {
      var directory = this.directory_Edit.text.trim();
      settings.inputDirectory = directory;
      if ( directory.length == 0 || !File.directoryExists( directory ) )
      {
         ( new MessageBox( "Select an existing folder first.",
                           TITLE, StdIcon_Warning, StdButton_Ok ) ).execute();
         return;
      }

      var paths = scanDirectory( directory, settings.filter, settings.recursive );
      if ( paths.length == 0 )
      {
         ( new MessageBox( "No files match the filter in that folder.",
                           TITLE, StdIcon_Information, StdButton_Ok ) ).execute();
         return;
      }

      this.aborted = false;
      this.setBusy( true );
      this.measurements = [];
      this.tree.clear();

      console.show();
      console.writeln( "<end><cbr><br>" + TITLE + ": measuring " +
                       paths.length + " frames..." );

      // The region of interest is in pixels, so the geometry of the first
      // frame is read to place it. Every frame of a session shares it.
      var roi = null;
      if ( settings.useROI )
      {
         var geometry = imageGeometry( paths[0] );
         if ( geometry == null )
            console.warningln( "The geometry of the frames could not be read, " +
                               "the whole frame is measured." );
         else
         {
            roi = centralROI( geometry, settings.roiPercent );
            console.writeln( format(
               "Measuring the central %d x %d pixels of %d x %d.",
               roi.x1 - roi.x0, roi.y1 - roi.y0,
               geometry.width, geometry.height ) );
         }
      }

      var startTime = Date.now();
      var batchSize = Math.max( 1, Math.round( settings.batchSize ) );
      var failed = [];
      var partial = false;
      var measured = 0;

      for ( var first = 0; first < paths.length; first += batchSize )
      {
         if ( this.aborted )
         {
            console.warningln( "Measurement stopped by the user." );
            break;
         }

         var batch = paths.slice( first, first + batchSize );
         this.windowTitle = format( "%s %s - measuring %d-%d of %d",
                                    TITLE, VERSION, first + 1,
                                    first + batch.length, paths.length );
         processEvents();

         var rows = [];
         try
         {
            rows = measureBatch( batch, roi );
         }
         catch ( x )
         {
            console.criticalln( "Batch starting at " + fileNameOf( batch[0] ) +
                                ": " + x );
         }

         // A frame SubframeSelector could not read is simply missing from the
         // table, so the batch is matched back against what was asked for.
         var byPath = {};
         for ( var r = 0; r < rows.length; ++r )
         {
            if ( rows[r].partial )
               partial = true;
            byPath[rows[r].path] = rows[r];
            byPath[rows[r].fileName] = rows[r];
         }
         for ( var b = 0; b < batch.length; ++b )
         {
            var m = byPath[batch[b]] || byPath[fileNameOf( batch[b] )];
            if ( m == null )
            {
               failed.push( batch[b] );
               continue;
            }
            this.measurements.push( m );
            ++measured;
         }

         console.writeln( format( "   %d/%d frames measured.",
                                  measured, paths.length ) );
      }

      this.windowTitle = TITLE + " " + VERSION;
      this.setBusy( false );

      if ( partial )
         console.warningln(
            "This build of SubframeSelector reports a measurements table this " +
            "script does not know in full. FWHM and eccentricity are " +
            "available, the rest of the variables are not." );

      if ( failed.length > 0 )
      {
         console.warningln( failed.length + " frames could not be measured:" );
         for ( var f = 0; f < failed.length; ++f )
            console.warningln( "   " + fileNameOf( failed[f] ) );
      }

      var elapsed = (Date.now() - startTime)/1000;
      console.noteln( format( "%d frames measured in %.1f s (%.2f s/frame).",
                              this.measurements.length, elapsed,
                              (this.measurements.length > 0) ?
                                 elapsed/this.measurements.length : 0 ) );

      this.stats = computeStatistics( this.measurements );
      for ( var r = 0; r < this.rows.length; ++r )
         this.rows[r].seedAbsoluteLimits( this.stats );
      this.refresh();
   };

   /*
    * Recomputes the statistics, reapplies the filters and repaints everything.
    * This is what every control of the criteria panel calls, so it has to stay
    * cheap: no file is read here.
    */
   this.refresh = function()
   {
      this.stats = computeStatistics( this.measurements );
      this.limits = applyFilters( this.measurements, this.stats );
      for ( var i = 0; i < this.rows.length; ++i )
         this.rows[i].updateEffective( this.limits, this.stats );
      this.rebuildTree();
      this.updateStatistics();
   };

   this.sortedMeasurements = function()
   {
      var list = this.measurements.slice();
      var item = this.sort_Combo.currentItem;
      if ( item == 0 )
         list.sort( function( a, b )
         {
            return (a.fileName < b.fileName) ? -1 : ((a.fileName > b.fileName) ? 1 : 0);
         } );
      else
      {
         var key = METRICS[item - 1].key;
         list.sort( function( a, b )
         {
            var va = a[key], vb = b[key];
            var fa = isFiniteNumber( va ), fb = isFiniteNumber( vb );
            if ( !fa && !fb )
               return 0;
            if ( !fa )
               return 1;
            if ( !fb )
               return -1;
            return va - vb;
         } );
      }
      return list;
   };

   this.rebuildTree = function()
   {
      var selected = {};
      for ( var s = 0; s < this.tree.numberOfChildren; ++s )
         if ( this.tree.child( s ).selected )
            selected[this.tree.child( s ).measurement.path] = true;

      this.tree.clear();
      var list = this.sortedMeasurements();
      for ( var i = 0; i < list.length; ++i )
      {
         var m = list[i];
         var node = new TreeBoxNode( this.tree );
         node.measurement = m;
         node.setText( 0, m.fileName );
         node.setToolTip( 0, m.path );
         for ( var c = 0; c < LIST_COLUMNS.length; ++c )
         {
            var metric = metricByKey( LIST_COLUMNS[c] );
            node.setText( c + 1, fmt( m[metric.key], metric.precision ) );
            node.setAlignment( c + 1, TextAlign_Right | TextAlign_VertCenter );
         }

         var statusColumn = this.tree.numberOfColumns - 1;
         var status;
         if ( m.pinned )
            status = m.keep ? "pinned, keep" : "pinned, reject";
         else
            status = m.keep ? "keep" : "reject";
         node.setText( statusColumn, status );

         var color = m.pinned ? COLOR_PINNED : (m.keep ? COLOR_KEEP : COLOR_REJECT);
         for ( var k = 0; k < this.tree.numberOfColumns; ++k )
            node.setTextColor( k, color );

         if ( m.reasons.length > 0 )
            node.setToolTip( statusColumn, m.reasons.join( "\n" ) );

         if ( selected[m.path] )
            node.selected = true;
      }

      for ( var w = 0; w < this.tree.numberOfColumns; ++w )
         this.tree.adjustColumnWidthToContents( w );
   };

   this.updateStatistics = function()
   {
      if ( this.measurements.length == 0 )
      {
         this.stats_Label.text = "<p>No frames measured yet.</p>";
         return;
      }

      var kept = [], rejected = [];
      for ( var i = 0; i < this.measurements.length; ++i )
         (this.measurements[i].keep ? kept : rejected).push( this.measurements[i] );

      var total = this.measurements.length;
      var text = format(
         "<p><b>%d frames</b> &nbsp; <font color=\"#1e8f3e\">kept %d " +
         "(%.1f%%)</font> &nbsp; <font color=\"#c62828\">rejected %d " +
         "(%.1f%%)</font></p>",
         total, kept.length, 100.0*kept.length/total,
         rejected.length, 100.0*rejected.length/total );

      // Median of the main variables before and after the cull, which is the
      // quickest way to tell whether the criteria are actually buying quality.
      var summaryKeys = [ "fwhm", "eccentricity", "snrWeight", "median" ];
      var parts = [];
      for ( var k = 0; k < summaryKeys.length; ++k )
      {
         var metric = metricByKey( summaryKeys[k] );
         var all = [], sel = [];
         for ( var j = 0; j < this.measurements.length; ++j )
         {
            var v = this.measurements[j][metric.key];
            if ( isFiniteNumber( v ) )
            {
               all.push( v );
               if ( this.measurements[j].keep )
                  sel.push( v );
            }
         }
         if ( all.length == 0 )
            continue;
         var before = median( all );
         var after = (sel.length > 0) ? median( sel ) : NaN;
         parts.push( format( "%s %s &rarr; <b>%s</b>", metric.title,
                             fmt( before, metric.precision ),
                             fmt( after, metric.precision ) ) );
      }
      if ( parts.length > 0 )
         text += "<p>Median of the batch &rarr; median of the kept frames:<br/>" +
                 parts.join( " &nbsp;&nbsp; " ) + "</p>";

      this.stats_Label.text = text;
   };

   this.togglePin = function( nodes )
   {
      if ( nodes == null || nodes.length == 0 )
         return;
      for ( var i = 0; i < nodes.length; ++i )
      {
         var m = nodes[i].measurement;
         if ( m == null )
            continue;
         if ( m.pinned )
            m.pinned = false;
         else
         {
            m.pinned = true;
            m.pinnedKeep = m.keep;
         }
      }
      this.refresh();
   };

   this.forcePin = function( nodes, keep )
   {
      if ( nodes == null || nodes.length == 0 )
         return;
      for ( var i = 0; i < nodes.length; ++i )
      {
         var m = nodes[i].measurement;
         if ( m == null )
            continue;
         m.pinned = true;
         m.pinnedKeep = keep;
      }
      this.refresh();
   };

   this.writeCSVFile = function( directory )
   {
      var columns = [ "file", "status" ];
      for ( var i = 0; i < METRICS.length; ++i )
         columns.push( METRICS[i].key );
      var lines = [ columns.join( "," ) ];

      var list = this.sortedMeasurements();
      for ( var j = 0; j < list.length; ++j )
      {
         var m = list[j];
         var fields = [ "\"" + m.fileName + "\"", m.keep ? "keep" : "reject" ];
         for ( var k = 0; k < METRICS.length; ++k )
         {
            var v = m[METRICS[k].key];
            fields.push( isFiniteNumber( v ) ? format( "%.6f", v ) : "" );
         }
         lines.push( fields.join( "," ) );
      }

      var path = directory + "/SubframeCuller.csv";
      try
      {
         File.writeTextFile( path, lines.join( "\n" ) + "\n" );
         console.noteln( "Measurements written to " + path );
      }
      catch ( x )
      {
         console.criticalln( "The CSV file could not be written: " + x );
      }
   };

   this.moveRejected = function()
   {
      if ( this.measurements.length == 0 )
      {
         ( new MessageBox( "Measure a folder first.",
                           TITLE, StdIcon_Information, StdButton_Ok ) ).execute();
         return;
      }

      var rejected = [];
      for ( var i = 0; i < this.measurements.length; ++i )
         if ( !this.measurements[i].keep )
            rejected.push( this.measurements[i] );

      if ( rejected.length == 0 )
      {
         ( new MessageBox( "No frame is being rejected.",
                           TITLE, StdIcon_Information, StdButton_Ok ) ).execute();
         return;
      }

      var folder = settings.rejectsFolder;
      var message = format(
         "%d of %d frames are going to be moved to the \"%s\" subfolder.\n\n" +
         "Continue?", rejected.length, this.measurements.length, folder );
      var box = new MessageBox( message, TITLE, StdIcon_Question,
                                StdButton_Yes, StdButton_No );
      if ( box.execute() != StdButton_Yes )
         return;

      var moved = 0;
      var failures = [];
      for ( var j = 0; j < rejected.length; ++j )
      {
         var m = rejected[j];
         var target = directoryOf( m.path ) + '/' + folder;
         try
         {
            if ( !File.directoryExists( target ) )
               File.createDirectory( target, true );

            var destination = target + '/' + m.fileName;
            if ( File.exists( destination ) )
            {
               failures.push( m.fileName + ": already in the rejects folder" );
               continue;
            }
            File.move( m.path, destination );
            m.path = destination;
            m.moved = true;
            ++moved;
         }
         catch ( x )
         {
            failures.push( m.fileName + ": " + x );
         }
      }

      console.noteln( format( "%d frames moved to \"%s\".", moved, folder ) );
      for ( var f = 0; f < failures.length; ++f )
         console.criticalln( failures[f] );

      if ( settings.writeCSV && settings.inputDirectory.length > 0 )
         this.writeCSVFile( settings.inputDirectory );

      saveSettings( settings );

      // The moved frames are no longer where they were, so they leave the list.
      var remaining = [];
      for ( var k = 0; k < this.measurements.length; ++k )
         if ( !this.measurements[k].moved )
            remaining.push( this.measurements[k] );
      this.measurements = remaining;
      this.refresh();

      var report = format( "%d frames moved to \"%s\".", moved, folder );
      if ( failures.length > 0 )
         report += format( "\n%d could not be moved, see the console.",
                           failures.length );
      ( new MessageBox( report, TITLE, StdIcon_Information,
                        StdButton_Ok ) ).execute();
   };

   this.refresh();
}

SubframeCullerDialog.prototype = new Dialog;

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

function main()
{
   if ( typeof SubframeSelector == "undefined" )
   {
      ( new MessageBox( "The SubframeSelector process is not available in " +
                        "this installation.", TITLE, StdIcon_Error,
                        StdButton_Ok ) ).execute();
      return;
   }

   // The dialog is modeless so that PixInsight stays usable while the frames
   // are being reviewed. The script has to stay alive for the window to exist,
   // hence the event loop.
   var dialog = new SubframeCullerDialog();
   dialog.show();
   while ( dialog.visible )
   {
      processEvents();
      msleep( 20 );
   }

   saveSettings( settings );
}

main();
