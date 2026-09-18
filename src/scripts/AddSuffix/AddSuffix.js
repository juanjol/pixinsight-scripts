/*
 * AddSuffix 1.1
 * Appends a suffix to the identifier of an image.
 *
 * Can be run from the Script menu, or saved as a process icon (new instance
 * button) and dragged onto an image.
 */

#feature-id    AddSuffix : Toolbox > Add Suffix
#feature-info  Appends a configurable suffix to the identifier of an image.

#include <pjsr/Sizer.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>

#define TITLE   "AddSuffix"
#define VERSION "1.1"

// ----------------------------------------------------------------------------
// Persistent parameters - this is what gets stored in the icon
// ----------------------------------------------------------------------------

function AddSuffixParameters()
{
   this.suffix    = "_BN";
   this.duplicate = false;

   this.save = function()
   {
      Parameters.set( "suffix", this.suffix );
      Parameters.set( "duplicate", this.duplicate );
   };

   this.load = function()
   {
      if ( Parameters.has( "suffix" ) )
         this.suffix = Parameters.getString( "suffix" );
      if ( Parameters.has( "duplicate" ) )
         this.duplicate = Parameters.getBoolean( "duplicate" );
   };
}

var parameters = new AddSuffixParameters();

// ----------------------------------------------------------------------------
// Core
// ----------------------------------------------------------------------------

function validId( s )
{
   s = s.replace( /[^0-9A-Za-z_]/g, "_" );
   return /^[0-9]/.test( s ) ? "_" + s : s;
}

function duplicateView( view, newId )
{
   var img = view.image;
   var w = new ImageWindow( img.width, img.height, img.numberOfChannels,
                            img.bitsPerSample, img.isReal, img.isColor, newId );
   w.mainView.beginProcess( UndoFlag_NoSwapFile );
   w.mainView.image.assign( img );
   w.mainView.endProcess();
   w.show();
   return w.mainView;
}

function applySuffix( view )
{
   if ( view.isNull )
      throw new Error( "Invalid view." );

   var newId = validId( view.id + parameters.suffix );

   if ( parameters.duplicate )
   {
      var v = duplicateView( view, newId );
      console.noteln( "Copy created: " + v.id );
   }
   else
   {
      var P = new ImageIdentifier;
      P.id = newId;
      P.executeOn( view, false );
      console.noteln( "New identifier: " + view.id );
   }
}

// ----------------------------------------------------------------------------
// Dialog
// ----------------------------------------------------------------------------

function AddSuffixDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   this.windowTitle = TITLE + " " + VERSION;

   this.suffix_Label = new Label( this );
   this.suffix_Label.text = "Suffix:";
   this.suffix_Label.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.suffix_Edit = new Edit( this );
   this.suffix_Edit.text = parameters.suffix;
   this.suffix_Edit.setScaledMinWidth( 160 );
   this.suffix_Edit.toolTip = "String appended to the current identifier.";
   this.suffix_Edit.onEditCompleted = function()
   {
      parameters.suffix = this.text;
   };

   this.suffix_Sizer = new HorizontalSizer;
   this.suffix_Sizer.spacing = 6;
   this.suffix_Sizer.add( this.suffix_Label );
   this.suffix_Sizer.add( this.suffix_Edit, 100 );

   this.duplicate_Check = new CheckBox( this );
   this.duplicate_Check.text = "Duplicate the image instead of renaming it";
   this.duplicate_Check.checked = parameters.duplicate;
   this.duplicate_Check.onCheck = function( checked )
   {
      parameters.duplicate = checked;
   };

   // New instance button: drag it to the workspace to create the icon
   this.newInstance_Button = new ToolButton( this );
   this.newInstance_Button.icon = this.scaledResource( ":/process-interface/new-instance.png" );
   this.newInstance_Button.setScaledFixedSize( 24, 24 );
   this.newInstance_Button.toolTip = "New instance: drag to the workspace to create an icon.";
   this.newInstance_Button.onMousePress = function()
   {
      this.hasFocus = true;
      parameters.suffix = this.dialog.suffix_Edit.text;
      parameters.duplicate = this.dialog.duplicate_Check.checked;
      parameters.save();
      this.pushed = false;
      this.dialog.newInstance();
   };

   this.apply_Button = new PushButton( this );
   this.apply_Button.text = "Apply";
   this.apply_Button.icon = this.scaledResource( ":/icons/execute.png" );
   this.apply_Button.toolTip = "Apply to the active image. The window stays open.";
   this.apply_Button.onClick = function()
   {
      parameters.suffix = this.dialog.suffix_Edit.text;
      parameters.duplicate = this.dialog.duplicate_Check.checked;

      var w = ImageWindow.activeWindow;
      if ( w.isNull )
      {
         ( new MessageBox( "There is no active image.",
                           TITLE, StdIcon_Information, StdButton_Ok ) ).execute();
         return;
      }
      try
      {
         applySuffix( w.mainView );
      }
      catch ( x )
      {
         ( new MessageBox( "" + x, TITLE, StdIcon_Error, StdButton_Ok ) ).execute();
      }
   };

   this.close_Button = new PushButton( this );
   this.close_Button.text = "Close";
   this.close_Button.icon = this.scaledResource( ":/icons/close.png" );
   this.close_Button.onClick = function()
   {
      parameters.suffix = this.dialog.suffix_Edit.text;
      parameters.duplicate = this.dialog.duplicate_Check.checked;
      this.dialog.hide();
   };

   this.buttons_Sizer = new HorizontalSizer;
   this.buttons_Sizer.spacing = 6;
   this.buttons_Sizer.add( this.newInstance_Button );
   this.buttons_Sizer.addStretch();
   this.buttons_Sizer.add( this.apply_Button );
   this.buttons_Sizer.add( this.close_Button );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.suffix_Sizer );
   this.sizer.add( this.duplicate_Check );
   this.sizer.addSpacing( 4 );
   this.sizer.add( this.buttons_Sizer );

   this.adjustToContents();
   this.setFixedHeight();
}

AddSuffixDialog.prototype = new Dialog;

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

function main()
{
   if ( Parameters.isGlobalTarget )
   {
      console.criticalln( TITLE + ": run it on an image, not in global context." );
      return;
   }

   // Icon dropped on an image: no dialog
   if ( Parameters.isViewTarget )
   {
      parameters.load();
      applySuffix( Parameters.targetView );
      return;
   }

   // Run from the Script menu
   parameters.load();

   // The dialog is shown as a modeless window, so PixInsight stays usable while
   // it is open and the suffix can be applied to one image after another. The
   // script has to stay alive for the window to exist, so the application event
   // loop is pumped here until it is closed.
   var dialog = new AddSuffixDialog();
   dialog.show();
   while ( dialog.visible )
   {
      processEvents();
      msleep( 20 );
   }
}

main();
