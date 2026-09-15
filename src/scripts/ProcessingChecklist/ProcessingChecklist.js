/*
 * ProcessingChecklist.js
 *
 * An interactive processing cheat sheet for PixInsight.
 *
 *  - A list of steps with tick boxes.
 *  - Several workflows selectable from a drop-down list.
 *  - Create, duplicate, rename and delete your own workflows.
 *  - Add, edit, reorder and remove steps.
 *  - Each step may reference a PixInsight process that can be opened
 *    with a single click.
 *  - Everything is stored automatically in PixInsight settings and can be
 *    exported to / imported from a JSON file.
 *
 * Requires PixInsight 1.8.8 or later.
 *
 * Copyright (c) 2026. Released under the MIT License.
 */

#feature-id    Utilities > Processing Checklist

#feature-info  An interactive processing cheat sheet. Keeps several predefined or \
               user-defined workflows, lets you tick off each step as you go, and \
               opens the PixInsight process associated with every step.

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/DataType.jsh>

#define TITLE        "Processing Checklist"
#define VERSION      "1.0.0"
#define SETTINGS_KEY "ProcessingChecklist/data"

// ----------------------------------------------------------------------------
// Default data
// ----------------------------------------------------------------------------

function S( title, process, note )
{
   return { title: title, process: process, note: note, done: false };
}

function defaultData()
{
   return {
      version: 1,
      active: 0,
      workflows: [
         {
            name: "1 - Preprocessing (WBPP)",
            steps: [
               S( "Review and cull subframes", "Blink",
                  "Clouds, satellites, tracking errors, focus drift." ),
               S( "Check calibration masters", "ImageCalibration",
                  "Same gain, offset and temperature as the lights." ),
               S( "Run WBPP", "",
                  "Calibration + cosmetic correction + registration + integration." ),
               S( "Inspect the rejection maps", "",
                  "Make sure no real signal or faint stars are being rejected." ),
               S( "Crop the stacking edges", "DynamicCrop",
                  "Remove the ragged borders left by dithering." ),
               S( "Plate solve", "",
                  "ImageSolver script; required later by SPCC." ),
               S( "Save the linear master", "",
                  "32-bit XISF, untouched copy before any processing." )
            ]
         },
         {
            name: "2 - Linear RGB",
            steps: [
               S( "Gradient correction", "GradientCorrection",
                  "Or DBE / GraXpert if you prefer." ),
               S( "Colour calibration", "SpectrophotometricColorCalibration",
                  "Needs a valid astrometric solution." ),
               S( "Deconvolution / PSF correction", "BlurXTerminator",
                  "Always before any noise reduction." ),
               S( "Linear noise reduction", "NoiseXTerminator", "" ),
               S( "Remove the stars", "StarXTerminator",
                  "Keep the star layer in a separate image." ),
               S( "Stretch the starless image", "HistogramTransformation",
                  "Aim for a background around 0.10 - 0.12." ),
               S( "Stretch the star layer", "HistogramTransformation",
                  "Gentler than the stretch applied to the object." )
            ]
         },
         {
            name: "3 - Non-linear",
            steps: [
               S( "Global contrast", "CurvesTransformation", "" ),
               S( "Selective saturation", "CurvesTransformation",
                  "Saturation curve with a luminance mask." ),
               S( "Tame the core", "HDRMultiscaleTransform",
                  "Only if there are blown-out regions." ),
               S( "Local contrast", "LocalHistogramEqualization", "" ),
               S( "Detail enhancement", "MultiscaleLinearTransform",
                  "Use a mask to protect the background." ),
               S( "Final noise reduction", "NoiseXTerminator",
                  "On the background, with an inverted mask." ),
               S( "Recombine the stars", "PixelMath",
                  "~ 1 - (1-starless)*(1-stars)" ),
               S( "Final tweaks and export", "",
                  "White balance, final crop, save TIFF/JPG." )
            ]
         },
         {
            name: "4 - SHO narrowband",
            steps: [
               S( "Process each channel while linear", "",
                  "Gradients, deconvolution and noise separately." ),
               S( "Match the channels", "LinearFit",
                  "Use the channel with the best SNR as reference." ),
               S( "Combine into SHO", "ChannelCombination",
                  "R = S II, G = H alpha, B = O III." ),
               S( "Remove green cast", "SCNR", "" ),
               S( "Shape the palette", "CurvesTransformation",
                  "Hue curve to push towards gold and blue tones." ),
               S( "Remove stars and stretch", "StarXTerminator", "" ),
               S( "Add RGB stars", "PixelMath",
                  "Stars from an RGB session for natural star colour." )
            ]
         }
      ]
   };
}

// ----------------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------------

function isValidData( d )
{
   return d != null && d.workflows != null && d.workflows.length > 0;
}

function loadData()
{
   try
   {
      var json = Settings.read( SETTINGS_KEY, DataType_String );
      if ( Settings.lastReadOK && json != null && json.length > 0 )
      {
         var d = JSON.parse( json );
         if ( isValidData( d ) )
            return d;
      }
   }
   catch ( x )
   {
      console.warningln( "** Could not read settings: " + x );
   }
   return defaultData();
}

function saveData( data )
{
   try
   {
      Settings.write( SETTINGS_KEY, DataType_String, JSON.stringify( data ) );
   }
   catch ( x )
   {
      console.warningln( "** Could not write settings: " + x );
   }
}

function writeTextFile( path, text )
{
   var f = new File;
   f.createForWriting( path );
   f.write( ByteArray.stringToUTF8( text ) );
   f.close();
}

function readTextFile( path )
{
   var f = new File;
   f.openForReading( path );
   var b = f.read( DataType_ByteArray, f.size );
   f.close();
   return b.utf8ToString();
}

// ----------------------------------------------------------------------------
// Generic text input dialog
// ----------------------------------------------------------------------------

function TextInputDialog( caption, label, value )
{
   this.__base__ = Dialog;
   this.__base__();

   var self = this;
   this.result = value;

   this.windowTitle = caption;

   this.label = new Label( this );
   this.label.text = label;
   this.label.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.edit = new Edit( this );
   this.edit.text = value;
   this.edit.setScaledMinWidth( 280 );
   this.edit.onEditCompleted = function()
   {
      self.result = this.text.trim();
   };

   this.ok_Button = new PushButton( this );
   this.ok_Button.text = "OK";
   this.ok_Button.icon = this.scaledResource( ":/icons/ok.png" );
   this.ok_Button.onClick = function()
   {
      self.result = self.edit.text.trim();
      if ( self.result.length == 0 )
      {
         ( new MessageBox( "The name cannot be empty.",
                           TITLE, StdIcon_Error, StdButton_Ok ) ).execute();
         return;
      }
      self.ok();
   };

   this.cancel_Button = new PushButton( this );
   this.cancel_Button.text = "Cancel";
   this.cancel_Button.icon = this.scaledResource( ":/icons/cancel.png" );
   this.cancel_Button.onClick = function() { self.cancel(); };

   this.inputSizer = new HorizontalSizer;
   this.inputSizer.spacing = 6;
   this.inputSizer.add( this.label );
   this.inputSizer.add( this.edit, 100 );

   this.buttonsSizer = new HorizontalSizer;
   this.buttonsSizer.spacing = 6;
   this.buttonsSizer.addStretch();
   this.buttonsSizer.add( this.ok_Button );
   this.buttonsSizer.add( this.cancel_Button );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 10;
   this.sizer.spacing = 10;
   this.sizer.add( this.inputSizer );
   this.sizer.add( this.buttonsSizer );

   this.adjustToContents();
   this.setFixedHeight();
}

TextInputDialog.prototype = new Dialog;

function askText( caption, label, value )
{
   var d = new TextInputDialog( caption, label, value );
   return ( d.execute() ) ? d.result : null;
}

// ----------------------------------------------------------------------------
// Step editor dialog
// ----------------------------------------------------------------------------

function StepDialog( step )
{
   this.__base__ = Dialog;
   this.__base__();

   var self = this;
   this.step = { title:   step ? step.title   : "",
                 process: step ? step.process : "",
                 note:    step ? step.note    : "",
                 done:    step ? step.done    : false };

   this.windowTitle = step ? "Edit Step" : "New Step";

   var labelWidth = this.font.width( "Linked process:" ) + 8;

   this.titleLabel = new Label( this );
   this.titleLabel.text = "Step:";
   this.titleLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.titleLabel.setFixedWidth( labelWidth );

   this.titleEdit = new Edit( this );
   this.titleEdit.text = this.step.title;
   this.titleEdit.setScaledMinWidth( 340 );

   this.processLabel = new Label( this );
   this.processLabel.text = "Linked process:";
   this.processLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.processLabel.setFixedWidth( labelWidth );

   this.processEdit = new Edit( this );
   this.processEdit.text = this.step.process;
   this.processEdit.toolTip =
      "<p>Optional PixInsight process identifier.</p>" +
      "<p>For example: <i>CurvesTransformation</i>, <i>PixelMath</i>, " +
      "<i>DynamicCrop</i>. Used by the <i>Open process</i> button.</p>";

   this.noteLabel = new Label( this );
   this.noteLabel.text = "Notes:";
   this.noteLabel.textAlignment = TextAlign_Right | TextAlign_Top;
   this.noteLabel.setFixedWidth( labelWidth );

   this.noteBox = new TextBox( this );
   this.noteBox.text = this.step.note;
   this.noteBox.setScaledMinSize( 340, 90 );

   this.ok_Button = new PushButton( this );
   this.ok_Button.text = "OK";
   this.ok_Button.icon = this.scaledResource( ":/icons/ok.png" );
   this.ok_Button.onClick = function()
   {
      var t = self.titleEdit.text.trim();
      if ( t.length == 0 )
      {
         ( new MessageBox( "The step needs a name.",
                           TITLE, StdIcon_Error, StdButton_Ok ) ).execute();
         return;
      }
      self.step.title   = t;
      self.step.process = self.processEdit.text.trim();
      self.step.note    = self.noteBox.text.trim();
      self.ok();
   };

   this.cancel_Button = new PushButton( this );
   this.cancel_Button.text = "Cancel";
   this.cancel_Button.icon = this.scaledResource( ":/icons/cancel.png" );
   this.cancel_Button.onClick = function() { self.cancel(); };

   this.titleSizer = new HorizontalSizer;
   this.titleSizer.spacing = 6;
   this.titleSizer.add( this.titleLabel );
   this.titleSizer.add( this.titleEdit, 100 );

   this.processSizer = new HorizontalSizer;
   this.processSizer.spacing = 6;
   this.processSizer.add( this.processLabel );
   this.processSizer.add( this.processEdit, 100 );

   this.noteSizer = new HorizontalSizer;
   this.noteSizer.spacing = 6;
   this.noteSizer.add( this.noteLabel );
   this.noteSizer.add( this.noteBox, 100 );

   this.buttonsSizer = new HorizontalSizer;
   this.buttonsSizer.spacing = 6;
   this.buttonsSizer.addStretch();
   this.buttonsSizer.add( this.ok_Button );
   this.buttonsSizer.add( this.cancel_Button );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 10;
   this.sizer.spacing = 8;
   this.sizer.add( this.titleSizer );
   this.sizer.add( this.processSizer );
   this.sizer.add( this.noteSizer, 100 );
   this.sizer.add( this.buttonsSizer );

   this.adjustToContents();
   this.userResizable = true;
}

StepDialog.prototype = new Dialog;

// ----------------------------------------------------------------------------
// Main dialog
// ----------------------------------------------------------------------------

function ChecklistDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   var self = this;

   this.data = loadData();
   if ( this.data.active >= this.data.workflows.length )
      this.data.active = 0;
   this.updating = false;

   this.windowTitle = TITLE + " " + VERSION;

   // --- Helpers -------------------------------------------------------------

   this.currentWorkflow = function()
   {
      return self.data.workflows[ self.data.active ];
   };

   this.selectedIndex = function()
   {
      var nodes = self.tree.selectedNodes;
      if ( nodes.length == 0 )
         return -1;
      return self.tree.childIndex( nodes[0] );
   };

   this.commit = function()
   {
      saveData( self.data );
   };

   this.updateProgress = function()
   {
      var steps = self.currentWorkflow().steps;
      var done = 0;
      for ( var i = 0; i < steps.length; ++i )
         if ( steps[i].done )
            ++done;
      var pct = ( steps.length > 0 ) ? Math.round( 100*done/steps.length ) : 0;
      self.progressLabel.text = format( "Progress:  %d of %d steps  (%d%%)",
                                        done, steps.length, pct );
   };

   this.rebuildTree = function( keepIndex )
   {
      self.updating = true;
      self.tree.clear();
      var steps = self.currentWorkflow().steps;
      for ( var i = 0; i < steps.length; ++i )
      {
         var s = steps[i];
         var node = new TreeBoxNode( self.tree );
         node.checkable = true;
         node.checked = s.done ? true : false;
         node.setText( 0, format( "%2d. ", i+1 ) + s.title );
         node.setText( 1, s.process ? s.process : "" );
         node.setText( 2, s.note ? s.note : "" );
         if ( s.done )
            for ( var c = 0; c < 3; ++c )
               node.setTextColor( c, 0xFF909090 );
      }
      for ( var c = 0; c < 3; ++c )
         self.tree.adjustColumnWidthToContents( c );
      self.updating = false;

      if ( keepIndex != undefined && keepIndex >= 0 &&
           keepIndex < self.tree.numberOfChildren )
      {
         self.tree.currentNode = self.tree.child( keepIndex );
         self.tree.child( keepIndex ).selected = true;
      }
      self.updateProgress();
   };

   this.rebuildCombo = function()
   {
      self.updating = true;
      self.workflowCombo.clear();
      for ( var i = 0; i < self.data.workflows.length; ++i )
         self.workflowCombo.addItem( self.data.workflows[i].name );
      self.workflowCombo.currentItem = self.data.active;
      self.updating = false;
   };

   // --- Workflow selector ---------------------------------------------------

   this.workflowLabel = new Label( this );
   this.workflowLabel.text = "Workflow:";
   this.workflowLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.workflowCombo = new ComboBox( this );
   this.workflowCombo.setScaledMinWidth( 260 );
   this.workflowCombo.toolTip = "<p>Select the workflow to display.</p>";
   this.workflowCombo.onItemSelected = function( index )
   {
      if ( self.updating )
         return;
      self.data.active = index;
      self.commit();
      self.rebuildTree();
   };

   this.newWorkflow_Button = new PushButton( this );
   this.newWorkflow_Button.text = "New";
   this.newWorkflow_Button.icon = this.scaledResource( ":/icons/add.png" );
   this.newWorkflow_Button.toolTip = "<p>Create an empty workflow.</p>";
   this.newWorkflow_Button.onClick = function()
   {
      var name = askText( "New Workflow", "Name:", "My workflow" );
      if ( name == null )
         return;
      self.data.workflows.push( { name: name, steps: [] } );
      self.data.active = self.data.workflows.length - 1;
      self.commit();
      self.rebuildCombo();
      self.rebuildTree();
   };

   this.dupWorkflow_Button = new PushButton( this );
   this.dupWorkflow_Button.text = "Duplicate";
   this.dupWorkflow_Button.icon = this.scaledResource( ":/icons/copy.png" );
   this.dupWorkflow_Button.toolTip =
      "<p>Copy the current workflow so you can modify it without losing the original.</p>";
   this.dupWorkflow_Button.onClick = function()
   {
      var wf = self.currentWorkflow();
      var name = askText( "Duplicate Workflow", "Name:", wf.name + " (copy)" );
      if ( name == null )
         return;
      var copy = JSON.parse( JSON.stringify( wf ) );
      copy.name = name;
      self.data.workflows.push( copy );
      self.data.active = self.data.workflows.length - 1;
      self.commit();
      self.rebuildCombo();
      self.rebuildTree();
   };

   this.renameWorkflow_Button = new PushButton( this );
   this.renameWorkflow_Button.text = "Rename";
   this.renameWorkflow_Button.icon = this.scaledResource( ":/icons/document-edit.png" );
   this.renameWorkflow_Button.onClick = function()
   {
      var wf = self.currentWorkflow();
      var name = askText( "Rename Workflow", "Name:", wf.name );
      if ( name == null )
         return;
      wf.name = name;
      self.commit();
      self.rebuildCombo();
   };

   this.delWorkflow_Button = new PushButton( this );
   this.delWorkflow_Button.text = "Delete";
   this.delWorkflow_Button.icon = this.scaledResource( ":/icons/delete.png" );
   this.delWorkflow_Button.onClick = function()
   {
      if ( self.data.workflows.length < 2 )
      {
         ( new MessageBox( "At least one workflow must exist.",
                           TITLE, StdIcon_Information, StdButton_Ok ) ).execute();
         return;
      }
      var wf = self.currentWorkflow();
      var mb = new MessageBox( "Delete the workflow \"" + wf.name + "\"?",
                               TITLE, StdIcon_Question, StdButton_Yes, StdButton_No );
      if ( mb.execute() != StdButton_Yes )
         return;
      self.data.workflows.splice( self.data.active, 1 );
      self.data.active = 0;
      self.commit();
      self.rebuildCombo();
      self.rebuildTree();
   };

   this.workflowSizer = new HorizontalSizer;
   this.workflowSizer.spacing = 6;
   this.workflowSizer.add( this.workflowLabel );
   this.workflowSizer.add( this.workflowCombo, 100 );
   this.workflowSizer.add( this.newWorkflow_Button );
   this.workflowSizer.add( this.dupWorkflow_Button );
   this.workflowSizer.add( this.renameWorkflow_Button );
   this.workflowSizer.add( this.delWorkflow_Button );

   // --- Step list -----------------------------------------------------------

   this.tree = new TreeBox( this );
   this.tree.alternateRowColor = true;
   this.tree.headerVisible = true;
   this.tree.rootDecoration = false;
   this.tree.multipleSelection = false;
   this.tree.numberOfColumns = 3;
   this.tree.setHeaderText( 0, "Step" );
   this.tree.setHeaderText( 1, "Process" );
   this.tree.setHeaderText( 2, "Notes" );
   this.tree.setScaledMinSize( 680, 340 );

   this.tree.onNodeUpdated = function( node, column )
   {
      if ( self.updating )
         return;
      var i = self.tree.childIndex( node );
      if ( i < 0 )
         return;
      var steps = self.currentWorkflow().steps;
      steps[i].done = node.checked;
      self.commit();
      var color = node.checked ? 0xFF909090 : 0xFF000000;
      for ( var c = 0; c < 3; ++c )
         node.setTextColor( c, color );
      self.updateProgress();
   };

   this.tree.onNodeDoubleClicked = function( node, column )
   {
      self.editStep_Button.onClick();
   };

   // --- Step buttons --------------------------------------------------------

   this.addStep_Button = new PushButton( this );
   this.addStep_Button.text = "Add step";
   this.addStep_Button.icon = this.scaledResource( ":/icons/add.png" );
   this.addStep_Button.onClick = function()
   {
      var d = new StepDialog( null );
      if ( !d.execute() )
         return;
      var steps = self.currentWorkflow().steps;
      var i = self.selectedIndex();
      if ( i < 0 )
         steps.push( d.step );
      else
         steps.splice( i+1, 0, d.step );
      self.commit();
      self.rebuildTree( ( i < 0 ) ? steps.length-1 : i+1 );
   };

   this.editStep_Button = new PushButton( this );
   this.editStep_Button.text = "Edit";
   this.editStep_Button.icon = this.scaledResource( ":/icons/document-edit.png" );
   this.editStep_Button.onClick = function()
   {
      var i = self.selectedIndex();
      if ( i < 0 )
         return;
      var steps = self.currentWorkflow().steps;
      var d = new StepDialog( steps[i] );
      if ( !d.execute() )
         return;
      d.step.done = steps[i].done;
      steps[i] = d.step;
      self.commit();
      self.rebuildTree( i );
   };

   this.delStep_Button = new PushButton( this );
   this.delStep_Button.text = "Remove";
   this.delStep_Button.icon = this.scaledResource( ":/icons/remove.png" );
   this.delStep_Button.onClick = function()
   {
      var i = self.selectedIndex();
      if ( i < 0 )
         return;
      self.currentWorkflow().steps.splice( i, 1 );
      self.commit();
      self.rebuildTree( Math.min( i, self.currentWorkflow().steps.length-1 ) );
   };

   this.upStep_Button = new PushButton( this );
   this.upStep_Button.text = "Move up";
   this.upStep_Button.icon = this.scaledResource( ":/icons/up.png" );
   this.upStep_Button.onClick = function()
   {
      var i = self.selectedIndex();
      if ( i < 1 )
         return;
      var steps = self.currentWorkflow().steps;
      var s = steps[i]; steps[i] = steps[i-1]; steps[i-1] = s;
      self.commit();
      self.rebuildTree( i-1 );
   };

   this.downStep_Button = new PushButton( this );
   this.downStep_Button.text = "Move down";
   this.downStep_Button.icon = this.scaledResource( ":/icons/down.png" );
   this.downStep_Button.onClick = function()
   {
      var i = self.selectedIndex();
      var steps = self.currentWorkflow().steps;
      if ( i < 0 || i >= steps.length-1 )
         return;
      var s = steps[i]; steps[i] = steps[i+1]; steps[i+1] = s;
      self.commit();
      self.rebuildTree( i+1 );
   };

   this.launch_Button = new PushButton( this );
   this.launch_Button.text = "Open process";
   this.launch_Button.icon = this.scaledResource( ":/icons/execute.png" );
   this.launch_Button.toolTip =
      "<p>Open the interface of the process linked to the selected step.</p>";
   this.launch_Button.onClick = function()
   {
      var i = self.selectedIndex();
      if ( i < 0 )
         return;
      var id = self.currentWorkflow().steps[i].process;
      if ( !id || id.length == 0 )
      {
         ( new MessageBox( "This step has no linked process.",
                           TITLE, StdIcon_Information, StdButton_Ok ) ).execute();
         return;
      }
      try
      {
         ( new ProcessInstance( id ) ).launchInterface();
      }
      catch ( x )
      {
         ( new MessageBox( "Could not open the process \"" + id + "\".\n" +
                           "Check that the identifier is correct.",
                           TITLE, StdIcon_Error, StdButton_Ok ) ).execute();
      }
   };

   this.stepButtonsSizer = new VerticalSizer;
   this.stepButtonsSizer.spacing = 6;
   this.stepButtonsSizer.add( this.addStep_Button );
   this.stepButtonsSizer.add( this.editStep_Button );
   this.stepButtonsSizer.add( this.delStep_Button );
   this.stepButtonsSizer.addSpacing( 10 );
   this.stepButtonsSizer.add( this.upStep_Button );
   this.stepButtonsSizer.add( this.downStep_Button );
   this.stepButtonsSizer.addSpacing( 10 );
   this.stepButtonsSizer.add( this.launch_Button );
   this.stepButtonsSizer.addStretch();

   this.listSizer = new HorizontalSizer;
   this.listSizer.spacing = 8;
   this.listSizer.add( this.tree, 100 );
   this.listSizer.add( this.stepButtonsSizer );

   // --- Progress and global actions -----------------------------------------

   this.progressLabel = new Label( this );
   this.progressLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

   this.checkAll_Button = new PushButton( this );
   this.checkAll_Button.text = "Check all";
   this.checkAll_Button.onClick = function()
   {
      var steps = self.currentWorkflow().steps;
      for ( var i = 0; i < steps.length; ++i )
         steps[i].done = true;
      self.commit();
      self.rebuildTree();
   };

   this.uncheckAll_Button = new PushButton( this );
   this.uncheckAll_Button.text = "Uncheck all";
   this.uncheckAll_Button.icon = this.scaledResource( ":/icons/reload.png" );
   this.uncheckAll_Button.toolTip =
      "<p>Reset progress to start working on a new image.</p>";
   this.uncheckAll_Button.onClick = function()
   {
      var steps = self.currentWorkflow().steps;
      for ( var i = 0; i < steps.length; ++i )
         steps[i].done = false;
      self.commit();
      self.rebuildTree();
   };

   this.export_Button = new PushButton( this );
   this.export_Button.text = "Export";
   this.export_Button.icon = this.scaledResource( ":/icons/save.png" );
   this.export_Button.toolTip = "<p>Save all workflows to a JSON file.</p>";
   this.export_Button.onClick = function()
   {
      var sfd = new SaveFileDialog;
      sfd.caption = "Export Workflows";
      sfd.filters = [["JSON files", "*.json"]];
      sfd.initialPath = "processing-checklist.json";
      if ( !sfd.execute() )
         return;
      try
      {
         writeTextFile( sfd.fileName, JSON.stringify( self.data, null, 2 ) );
         console.noteln( "Workflows exported to: " + sfd.fileName );
      }
      catch ( x )
      {
         ( new MessageBox( "Error writing the file:\n" + x,
                           TITLE, StdIcon_Error, StdButton_Ok ) ).execute();
      }
   };

   this.import_Button = new PushButton( this );
   this.import_Button.text = "Import";
   this.import_Button.icon = this.scaledResource( ":/icons/open.png" );
   this.import_Button.toolTip =
      "<p>Load workflows from a JSON file. Replaces the current ones.</p>";
   this.import_Button.onClick = function()
   {
      var ofd = new OpenFileDialog;
      ofd.caption = "Import Workflows";
      ofd.multipleSelections = false;
      ofd.filters = [["JSON files", "*.json"]];
      if ( !ofd.execute() )
         return;
      try
      {
         var d = JSON.parse( readTextFile( ofd.fileName ) );
         if ( !isValidData( d ) )
            throw "The file does not contain valid workflows.";
         self.data = d;
         self.data.active = 0;
         self.commit();
         self.rebuildCombo();
         self.rebuildTree();
      }
      catch ( x )
      {
         ( new MessageBox( "Error reading the file:\n" + x,
                           TITLE, StdIcon_Error, StdButton_Ok ) ).execute();
      }
   };

   this.reset_Button = new PushButton( this );
   this.reset_Button.text = "Reset";
   this.reset_Button.toolTip =
      "<p>Restore the sample workflows. Your own workflows will be lost.</p>";
   this.reset_Button.onClick = function()
   {
      var mb = new MessageBox( "All your workflows will be deleted and the sample " +
                               "ones restored. Continue?",
                               TITLE, StdIcon_Warning, StdButton_Yes, StdButton_No );
      if ( mb.execute() != StdButton_Yes )
         return;
      self.data = defaultData();
      self.commit();
      self.rebuildCombo();
      self.rebuildTree();
   };

   this.close_Button = new PushButton( this );
   this.close_Button.text = "Close";
   this.close_Button.icon = this.scaledResource( ":/icons/close.png" );
   this.close_Button.onClick = function()
   {
      self.commit();
      self.ok();
   };

   this.bottomSizer = new HorizontalSizer;
   this.bottomSizer.spacing = 6;
   this.bottomSizer.add( this.progressLabel );
   this.bottomSizer.addStretch();
   this.bottomSizer.add( this.checkAll_Button );
   this.bottomSizer.add( this.uncheckAll_Button );
   this.bottomSizer.addSpacing( 10 );
   this.bottomSizer.add( this.export_Button );
   this.bottomSizer.add( this.import_Button );
   this.bottomSizer.add( this.reset_Button );
   this.bottomSizer.addSpacing( 10 );
   this.bottomSizer.add( this.close_Button );

   // --- Assembly ------------------------------------------------------------

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add( this.workflowSizer );
   this.sizer.add( this.listSizer, 100 );
   this.sizer.add( this.bottomSizer );

   this.rebuildCombo();
   this.rebuildTree();

   this.adjustToContents();
   this.userResizable = true;
}

ChecklistDialog.prototype = new Dialog;

// ----------------------------------------------------------------------------

function main()
{
   var dialog = new ChecklistDialog();
   dialog.execute();
}

main();
